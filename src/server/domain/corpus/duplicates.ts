import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import {
  characterEmbeddings,
  characterVersions,
  chatSegments,
  chats,
  duplicatePairs,
} from "../../../db/schema";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";

// Near-duplicate detection over the corpus vector tables (docs/planning/breadth-buildout.md B.5).
// Ported in spirit from card-curator server.py:925-987 (`find_duplicates`, raw-cosine threshold 0.92)
// + st-bridge embeddings.py:179-220 (CSLS correction). The all-pairs cosine LOADS vectors and does an
// exact in-process matmul — NOT the ANN index — because the ANN caps at ~200 results, applies WHERE
// after the k-nearest, and would need N queries (B.7). At corpus scale (296 chars, ~hundreds of chats)
// the exact O(n²) is tens of ms and complete. `similarCharacters` (one row → k nearest) DOES use the
// ANN — that's retrieval, the index's job.

const DIM = 1024; // BGE-M3 dimension (matches the F32_BLOB column)

export const DEFAULT_DUP_THRESHOLD = 0.92; // raw cosine; card-curator's default

export interface DuplicatePair {
  idA: string; // canonical: idA < idB lexicographically (so (a,b)/(b,a) dedupe)
  idB: string;
  cosine: number; // raw cosine — the interpretable, card-curator-comparable similarity
  csls: number; // CSLS-adjusted (2·cos − hubA − hubB) — the ranking key; hub-inflated pairs sink
}

// ── pure vector math (testable without a db) ─────────────────────────────────

/** Flatten + L2-normalize a group's vectors into one contiguous buffer (normalized → dot = cosine). */
function normalizeFlat(vecs: Float32Array[]): Float32Array {
  const n = vecs.length;
  const flat = new Float32Array(n * DIM);
  for (let i = 0; i < n; i += 1) {
    const v = vecs[i] ?? new Float32Array(DIM);
    let norm = 0;
    for (let d = 0; d < DIM; d += 1) {
      const x = v[d] ?? 0;
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    const base = i * DIM;
    for (let d = 0; d < DIM; d += 1) flat[base + d] = (v[d] ?? 0) / norm;
  }
  return flat;
}

/**
 * Exact all-pairs cosine; emit every pair with raw cosine ≥ `threshold`, deduped (a,b)/(b,a) via the
 * canonical id order, each annotated with its CSLS-adjusted score for ranking. `hubById` is the stored
 * CSLS hub_score (mean cos to the K nearest); a missing entry contributes 0 (no correction).
 */
export function pairsAboveThreshold(
  ids: readonly string[],
  vecs: readonly Float32Array[],
  hubById: ReadonlyMap<string, number>,
  threshold: number,
): DuplicatePair[] {
  const n = ids.length;
  const flat = normalizeFlat(vecs as Float32Array[]);
  const out: DuplicatePair[] = [];
  for (let i = 0; i < n; i += 1) {
    const bi = i * DIM;
    const idI = ids[i] ?? "";
    for (let j = i + 1; j < n; j += 1) {
      const bj = j * DIM;
      let cos = 0;
      for (let d = 0; d < DIM; d += 1) cos += (flat[bi + d] ?? 0) * (flat[bj + d] ?? 0);
      if (cos < threshold) continue;
      const idJ = ids[j] ?? "";
      const csls = 2 * cos - (hubById.get(idI) ?? 0) - (hubById.get(idJ) ?? 0);
      const [a, b] = idI < idJ ? [idI, idJ] : [idJ, idI];
      out.push({ idA: a, idB: b, cosine: cos, csls });
    }
  }
  return out;
}

// ── fork lineage (B.5.1) ─────────────────────────────────────────────────────

/**
 * Map each chatId to its FORK ROOT — the topmost ancestor reached by walking `parentChatId`. Two chats
 * with the same root are in one fork family (a fork + its parent, or two siblings); independent chats
 * are each their own root. Cycle-safe (a malformed parent chain stops at the first repeat).
 */
export function forkRoots(
  chatRows: readonly { id: string; parentChatId: string | null }[],
): Map<string, string> {
  const parent = new Map<string, string | null>();
  for (const c of chatRows) parent.set(c.id, c.parentChatId);
  const rootOf = new Map<string, string>();
  for (const c of chatRows) {
    let cur = c.id;
    const seen = new Set<string>();
    while (true) {
      const p = parent.get(cur);
      if (p === undefined || p === null || seen.has(p) || !parent.has(p)) break;
      seen.add(cur);
      cur = p;
    }
    rootOf.set(c.id, cur);
  }
  return rootOf;
}

/** Chat pairs sharing a fork root are a known lineage (`forked`); otherwise an independent look-alike. */
export function chatRelation(
  idA: string,
  idB: string,
  roots: ReadonlyMap<string, string>,
): "duplicate" | "forked" {
  const ra = roots.get(idA);
  const rb = roots.get(idB);
  return ra !== undefined && ra === rb ? "forked" : "duplicate";
}

// ── precompute (write the rollup; run by scripts/find-duplicates.ts) ─────────

export const DEFAULT_CHAT_JACCARD = 0.3; // ≥30% of blocks byte-identical = a real chat duplicate/fork

interface ComputeOpts {
  /** Character near-dup cosine threshold (card-curator's 0.92). */
  threshold?: number | undefined;
  /** Chat near-dup CONTENT-overlap (Jaccard of segment contentHashes) threshold. */
  chatThreshold?: number | undefined;
  /** Min messages for a chat to be eligible (short chats are false-positive prone). */
  minChatMessages?: number | undefined;
}

export interface DuplicateComputeStats {
  characters: number;
  chats: number;
  forkedChatPairs: number;
}

/**
 * Recompute `duplicate_pairs` for both entity types. Idempotent per (owner,type): clears the type's
 * rows then re-inserts. Characters: one embedding per character (no fork-dup possible — the unique
 * (characterId,model) index), so a straight all-pairs cosine pass. Chats: CONTENT-overlap (Jaccard of
 * segment contentHashes — NOT centroid cosine, which conflates same-character with duplicate), eligible
 * chats only, labeled `forked` vs `duplicate` by fork lineage (B.5.1) so a fork family reads as "3 forks
 * of this chat", not 3 dups.
 */
export async function computeDuplicatePairs(
  db: Db,
  opts: ComputeOpts = {},
): Promise<DuplicateComputeStats> {
  const threshold = opts.threshold ?? DEFAULT_DUP_THRESHOLD;
  const chatThreshold = opts.chatThreshold ?? DEFAULT_CHAT_JACCARD;
  const minMsgs = opts.minChatMessages ?? 20;
  const now = Date.now();

  // characters — group by (owner, model); one row per character.
  const charRows = await db
    .select({
      characterId: characterEmbeddings.characterId,
      ownerId: characterEmbeddings.ownerId,
      model: characterEmbeddings.model,
      embedding: characterEmbeddings.embedding,
      hubScore: characterEmbeddings.hubScore,
    })
    .from(characterEmbeddings);
  const charPairs = computeForGroups(
    charRows.map((r) => ({ id: r.characterId, ...r })),
    threshold,
  ).map((p) => ({ ...p, relation: "duplicate" as const }));

  // chats — duplication = shared-CONTENT overlap (Jaccard of segment contentHashes), NOT centroid
  // cosine. A per-chat centroid is dominated by the character's persistent voice, so same-character
  // chats falsely score ≥0.92 (MEASURED: 1609/1634 centroid "dups" were merely same-character — e.g. 51
  // distinct Hikari chats). Jaccard over content hashes (B.5.1) is precise — forks/re-imports share
  // identical blocks, independent same-character chats share at most a greeting — and embedder-swap-proof
  // (hashes are source-based, not vectors).
  const segRows = await db
    .select({
      chatId: chatSegments.chatId,
      ownerId: chatSegments.ownerId,
      model: chatSegments.model,
      contentHash: chatSegments.contentHash,
    })
    .from(chatSegments);
  const eligible = await db
    .select({ id: chats.id, parentChatId: chats.parentChatId, messageCount: chats.messageCount })
    .from(chats);
  const eligibleIds = new Set(
    eligible.filter((c) => (c.messageCount ?? 0) > minMsgs).map((c) => c.id),
  );
  const roots = forkRoots(eligible);
  const chatPairs = jaccardChatPairs(segRows, eligibleIds, chatThreshold).map((p) => ({
    idA: p.idA,
    idB: p.idB,
    cosine: p.jaccard, // stored in `similarity` — for chats it's content-overlap, not cosine
    csls: null,
    ownerId: p.ownerId,
    model: p.model,
    relation: chatRelation(p.idA, p.idB, roots),
  }));

  // Persist: clear + re-insert per (owner, type). Group owners from the pairs' members.
  await replacePairs(db, "character", charPairs, charRows, now);
  await replacePairs(db, "chat", chatPairs, segRows, now);

  const forked = chatPairs.filter((p) => p.relation === "forked").length;
  const stats: DuplicateComputeStats = {
    characters: charPairs.length,
    chats: chatPairs.length,
    forkedChatPairs: forked,
  };
  getLog().info({ ...stats, threshold }, "corpus: duplicate pairs computed");
  return stats;
}

interface GroupRow {
  id: string;
  ownerId: string;
  model: string;
  embedding: Float32Array | null;
  hubScore?: number | null;
}

/** Group by (ownerId, model) — cosine is only meaningful within one vector space — and emit pairs. */
function computeForGroups(
  rows: readonly GroupRow[],
  threshold: number,
): (DuplicatePair & { ownerId: string; model: string })[] {
  interface Grp {
    ids: string[];
    vecs: Float32Array[];
    hubs: Map<string, number>;
  }
  const groups = new Map<string, Grp>();
  for (const r of rows) {
    if (!r.embedding) continue;
    const key = `${r.ownerId} ${r.model}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { ids: [], vecs: [], hubs: new Map<string, number>() };
      groups.set(key, g);
    }
    g.ids.push(r.id);
    g.vecs.push(r.embedding);
    if (r.hubScore != null) g.hubs.set(r.id, r.hubScore);
  }
  const out: (DuplicatePair & { ownerId: string; model: string })[] = [];
  for (const [key, g] of groups) {
    const [ownerId, model] = key.split(" ") as [string, string];
    for (const p of pairsAboveThreshold(g.ids, g.vecs, g.hubs, threshold)) {
      out.push({ ...p, ownerId, model });
    }
  }
  return out;
}

export interface JaccardChatPair {
  idA: string;
  idB: string;
  jaccard: number;
  ownerId: string;
  model: string;
}

/**
 * Chat near-duplicates by CONTENT overlap: Jaccard of each chat's set of segment contentHashes. An
 * inverted index (hash → chats) means only chats that ACTUALLY share a block are compared, far below the
 * naive O(chats²) — and a chat with no shared block never appears. Eligible chats only; same-owner only
 * (two users' chats can't be the same chat). Canonical (idA<idB) pairs with jaccard ≥ threshold.
 */
export function jaccardChatPairs(
  segRows: readonly {
    chatId: string;
    ownerId: string;
    model: string;
    contentHash: string | null;
  }[],
  eligibleIds: ReadonlySet<string>,
  threshold: number,
): JaccardChatPair[] {
  const hashes = new Map<string, Set<string>>(); // chatId → its distinct block content hashes
  const ownerOf = new Map<string, string>();
  const modelOf = new Map<string, string>();
  for (const s of segRows) {
    if (s.contentHash === null || !eligibleIds.has(s.chatId)) continue;
    let set = hashes.get(s.chatId);
    if (set === undefined) {
      set = new Set();
      hashes.set(s.chatId, set);
    }
    set.add(s.contentHash);
    if (!ownerOf.has(s.chatId)) ownerOf.set(s.chatId, s.ownerId);
    if (!modelOf.has(s.chatId)) modelOf.set(s.chatId, s.model);
  }
  // Inverted index: each hash → the chats containing it (each chat at most once — per-chat set).
  const byHash = new Map<string, string[]>();
  for (const [chatId, set] of hashes) {
    for (const h of set) {
      const arr = byHash.get(h);
      if (arr) arr.push(chatId);
      else byHash.set(h, [chatId]);
    }
  }
  // Count shared hashes per candidate pair (only pairs co-occurring in some hash's list).
  const shared = new Map<string, number>();
  for (const chatIds of byHash.values()) {
    if (chatIds.length < 2) continue;
    for (let i = 0; i < chatIds.length; i += 1) {
      for (let j = i + 1; j < chatIds.length; j += 1) {
        const a0 = chatIds[i] ?? "";
        const b0 = chatIds[j] ?? "";
        if (ownerOf.get(a0) !== ownerOf.get(b0)) continue;
        const [a, b] = a0 < b0 ? [a0, b0] : [b0, a0];
        const key = `${a} ${b}`;
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }
  const out: JaccardChatPair[] = [];
  for (const [key, inter] of shared) {
    const [a, b] = key.split(" ") as [string, string];
    const union = (hashes.get(a)?.size ?? 0) + (hashes.get(b)?.size ?? 0) - inter;
    const jaccard = union > 0 ? inter / union : 0;
    if (jaccard >= threshold) {
      out.push({
        idA: a,
        idB: b,
        jaccard,
        ownerId: ownerOf.get(a) ?? "",
        model: modelOf.get(a) ?? "",
      });
    }
  }
  return out;
}

/** Clear this entity type's rows per owner, then insert the fresh pairs. */
async function replacePairs(
  db: Db,
  entityType: "character" | "chat",
  pairs: readonly {
    idA: string;
    idB: string;
    cosine: number;
    csls: number | null;
    ownerId: string;
    model: string;
    relation: "duplicate" | "forked";
  }[],
  ownerSource: readonly { ownerId: string }[],
  now: number,
): Promise<void> {
  const owners = new Set(ownerSource.map((r) => r.ownerId));
  for (const ownerId of owners) {
    await db
      .delete(duplicatePairs)
      .where(and(eq(duplicatePairs.ownerId, ownerId), eq(duplicatePairs.entityType, entityType)));
  }
  for (const p of pairs) {
    await db.insert(duplicatePairs).values({
      id: newId(),
      ownerId: p.ownerId,
      entityType,
      entityIdA: p.idA,
      entityIdB: p.idB,
      similarity: p.cosine,
      cslsScore: p.csls,
      relation: p.relation,
      model: p.model,
      computedAt: now,
    });
  }
}

// ── reads (the live tRPC path; cheap rollup lookups) ─────────────────────────

export interface DuplicateCharacterPair {
  characterIdA: string;
  characterIdB: string;
  nameA: string;
  nameB: string;
  similarity: number;
  relation: string;
}

export interface DuplicateChatPair {
  chatIdA: string;
  chatIdB: string;
  similarity: number;
  relation: "duplicate" | "forked";
}

/** Owner-scoped character duplicate pairs, names resolved, ranked by CSLS desc (hub artifacts sink). */
export async function readDuplicateCharacters(
  db: Db,
  ownerId: string,
  opts: { threshold?: number | undefined } = {},
): Promise<DuplicateCharacterPair[]> {
  const rows = await db
    .select()
    .from(duplicatePairs)
    .where(and(eq(duplicatePairs.ownerId, ownerId), eq(duplicatePairs.entityType, "character")));
  const filtered = rows.filter((r) => r.similarity >= (opts.threshold ?? 0));
  const ids = [...new Set(filtered.flatMap((r) => [r.entityIdA, r.entityIdB]))];
  const names = await characterNames(db, ids);
  return filtered
    .sort((a, b) => (b.cslsScore ?? b.similarity) - (a.cslsScore ?? a.similarity))
    .map((r) => ({
      characterIdA: r.entityIdA,
      characterIdB: r.entityIdB,
      nameA: names.get(r.entityIdA) ?? "Unknown",
      nameB: names.get(r.entityIdB) ?? "Unknown",
      similarity: r.similarity,
      relation: r.relation,
    }));
}

/** Owner-scoped chat duplicate pairs, ranked by CSLS desc. `forked` pairs are a known lineage. */
export async function readDuplicateChats(
  db: Db,
  ownerId: string,
  opts: { threshold?: number | undefined; includeForked?: boolean | undefined } = {},
): Promise<DuplicateChatPair[]> {
  const rows = await db
    .select()
    .from(duplicatePairs)
    .where(and(eq(duplicatePairs.ownerId, ownerId), eq(duplicatePairs.entityType, "chat")));
  return rows
    .filter((r) => r.similarity >= (opts.threshold ?? 0))
    .filter((r) => (opts.includeForked ?? true) || r.relation !== "forked")
    .sort((a, b) => (b.cslsScore ?? b.similarity) - (a.cslsScore ?? a.similarity))
    .map((r) => ({
      chatIdA: r.entityIdA,
      chatIdB: r.entityIdB,
      similarity: r.similarity,
      relation: r.relation === "forked" ? "forked" : "duplicate",
    }));
}

/**
 * "More like this" for one character — the live ANN path (port of card-curator server.py:663
 * `similar_cards`). One query → k nearest via the index, owner-scoped, self excluded.
 */
export async function similarCharacters(
  db: Db,
  characterId: string,
  ownerId: string,
  limit = 10,
): Promise<{ characterId: string; name: string; similarity: number }[]> {
  const self = await db
    .select({ embedding: characterEmbeddings.embedding })
    .from(characterEmbeddings)
    .where(eq(characterEmbeddings.characterId, characterId))
    .limit(1);
  const vec = self[0]?.embedding;
  if (!vec) return [];
  const query = JSON.stringify(Array.from(vec));
  const rows = await db.all<{ characterId: string; dist: number }>(sql`
    SELECT ce.character_id AS characterId,
           vector_distance_cos(ce.embedding, vector32(${query})) AS dist
    FROM vector_top_k('character_embeddings_ann', vector32(${query}), ${limit + 5}) AS v
    JOIN character_embeddings ce ON ce.rowid = v.id
    WHERE ce.owner_id = ${ownerId} AND ce.character_id != ${characterId}
    ORDER BY dist ASC
    LIMIT ${limit}
  `);
  const names = await characterNames(
    db,
    rows.map((r) => r.characterId),
  );
  return rows.map((r) => ({
    characterId: r.characterId,
    name: names.get(r.characterId) ?? "Unknown",
    similarity: 1 - r.dist,
  }));
}

/** characterId → current-version display name (one query). */
async function characterNames(db: Db, characterIds: string[]): Promise<Map<string, string>> {
  if (characterIds.length === 0) return new Map();
  const rows = await db
    .select({ characterId: characterVersions.characterId, name: characterVersions.name })
    .from(characterVersions)
    .where(inArray(characterVersions.characterId, characterIds));
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.characterId)) out.set(r.characterId, r.name);
  return out;
}
