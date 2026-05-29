import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterEmbeddings, chatDigests, chatSegments } from "../../../db/schema";
import { getLog } from "../../observability/logger";

// ── CSLS hubness precompute (index-time) ─────────────────────────────────────
// Some embeddings sit near the centroid of the space and are "near everything" — hubs
// that match any query moderately well and crowd out the specific result you wanted.
// CSLS (Cross-domain Similarity Local Scaling) corrects this: store each vector's
// hub_score (mean cosine-sim to its K nearest SAME-TYPE neighbours), then at query time
// penalize high-hub candidates (the re-rank half lives in domain/search). This is the
// good-vs-mediocre line for semantic search over a few-hundred-item corpus. Ported from
// card-curator index.py:62-89 (per-collection) + st-bridge embeddings.py:149-177.
//
// Per (entity_type, model), NOT global: a character card and a chat segment have very
// different vector distributions (identity text vs conversation chunk), so a mixed hub
// score skews both — card-curator computes per ChromaDB collection for the same reason.
//
// EXACT same-type top-K, NOT the ANN index. We tried `vector_top_k` per row first and it
// was WRONG for minority types: a popular character is surrounded by its OWN hundreds of
// chat segments, so the index's bounded result budget (~200 rows) is exhausted by within-
// type cross-traffic before 10 other characters surface → hub 0 for exactly the most-used
// cards. So we load each (type, model) group's vectors and compute same-type cosine
// exactly (normalized → dot product = cosine sim), keeping a bounded top-K per row — like
// card-curator's `embs @ embs.T`, but without materializing the full n² matrix.

// Canonical neighbourhood size. The stored hub_score bakes this in; changing it requires
// re-running `pnpm csls`. (card-curator index.py:21 `_CSLS_K = 10`.)
export const CSLS_K = 10;

const DIM = 1024; // BGE-M3 vector dimension (matches the F32_BLOB column)

export interface HubTypeStat {
  /** rows of this entity_type (across all models) */
  count: number;
  /** rows that got a computed hub_score */
  computed: number;
  /** rows zeroed because their (type,model) group has < K+1 members */
  skipped: number;
}

export interface HubStats {
  k: number;
  total: number;
  byType: Record<string, HubTypeStat>;
}

// Keep `top` as the K largest sims seen, sorted ascending (top[0] = current min). O(K) per
// offer; K is tiny so this beats a heap. noUncheckedIndexedAccess: bounds are ours, the
// `?? 0` fallbacks never fire for in-range indices.
function offer(top: number[], s: number, k: number): void {
  if (top.length < k) {
    let i = top.length - 1;
    top.push(s);
    while (i >= 0 && (top[i] ?? 0) > s) {
      top[i + 1] = top[i] ?? 0;
      i -= 1;
    }
    top[i + 1] = s;
  } else if (s > (top[0] ?? 0)) {
    let i = 0;
    while (i + 1 < k && (top[i + 1] ?? 0) < s) {
      top[i] = top[i + 1] ?? 0;
      i += 1;
    }
    top[i] = s;
  }
}

// Per-group exact pairwise-cosine top-K mean → each id's hub_score. A group with < k+1 members
// gets all-0 (no meaningful hubs). This is the vector-space math, factored out so every vector
// table shares it: the polymorphic `embeddings` AND the first-class chat_digests/chat_segments.
function computeGroupHubs(ids: string[], vecs: Float32Array[], k: number): Map<string, number> {
  const out = new Map<string, number>();
  const n = ids.length;
  if (n < k + 1) {
    for (const id of ids) out.set(id, 0);
    return out;
  }
  // Flatten + L2-normalize into one contiguous buffer (cache-friendly hot loop; normalizing
  // defensively removes any cpu-fp32 ↔ cuda-fp16 norm drift, so dot = cosine). `as number`: index
  // is provably in-bounds; the cast is a compile-time no-op (avoids noUncheckedIndexedAccess's
  // `?? 0`, which would add a runtime branch to the hot loop).
  const flat = new Float32Array(n * DIM);
  for (let i = 0; i < n; i += 1) {
    const v = vecs[i] ?? new Float32Array(DIM);
    let norm = 0;
    for (let d = 0; d < DIM; d += 1) {
      const x = v[d] as number;
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    const base = i * DIM;
    for (let d = 0; d < DIM; d += 1) flat[base + d] = (v[d] as number) / norm;
  }
  // Exact pairwise cosine, bounded top-K per row (symmetric → each pair offered to both).
  const top: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1) {
    const bi = i * DIM;
    const ti = top[i] ?? [];
    for (let j = i + 1; j < n; j += 1) {
      const bj = j * DIM;
      let s = 0;
      for (let d = 0; d < DIM; d += 1) s += (flat[bi + d] as number) * (flat[bj + d] as number);
      offer(ti, s, k);
      offer(top[j] ?? [], s, k);
    }
  }
  for (let i = 0; i < n; i += 1) {
    const t = top[i] ?? [];
    const mean = t.length > 0 ? t.reduce((a, b) => a + b, 0) / t.length : 0;
    out.set(ids[i] ?? "", mean);
  }
  return out;
}

/**
 * Precompute `embeddings.hub_score` for every row, per (entity_type, model). Idempotent
 * (a plain re-run overwrites). Run after the embed pass (`pnpm csls`); re-run when the
 * corpus changes. Groups with < K+1 members are zeroed (no meaningful hubs — mirrors
 * card-curator's `len(ids) < _CSLS_K + 1 → 0.0`).
 */
export async function computeCharacterHubScores(
  db: Db,
  opts: { k?: number } = {},
): Promise<HubStats> {
  const log = getLog();
  const k = opts.k ?? CSLS_K;

  const all = await db
    .select({
      id: characterEmbeddings.id,
      model: characterEmbeddings.model,
      embedding: characterEmbeddings.embedding,
    })
    .from(characterEmbeddings);

  // Group by model: exact dot products are only meaningful within one vector space. Character cards
  // are the only entity here (segments/digests have their own hub functions below), so the old
  // (entity_type, model) grouping collapses to per-model.
  const groups = new Map<string, { ids: string[]; vecs: Float32Array[] }>();
  for (const row of all) {
    if (!row.embedding) continue; // null vector can't be hub-scored (shouldn't exist post-embed)
    const g = groups.get(row.model) ?? { ids: [], vecs: [] };
    g.ids.push(row.id);
    g.vecs.push(row.embedding);
    groups.set(row.model, g);
  }

  const hubById = new Map<string, number>();
  const stat: HubTypeStat = { count: 0, computed: 0, skipped: 0 };
  for (const { ids, vecs } of groups.values()) {
    const n = ids.length;
    stat.count += n;
    if (n < k + 1)
      stat.skipped += n; // no meaningful hubs in a tiny group
    else stat.computed += n;
    for (const [id, hub] of computeGroupHubs(ids, vecs, k)) hubById.set(id, hub);
  }

  // Sequential auto-commit updates (NOT a transaction): drizzle's libSQL `transaction()` switches to
  // a fresh connection, empty on `:memory:`. hub_score is non-vector, so writing it never touches the
  // ANN shadow index.
  for (const [id, hub] of hubById) {
    await db
      .update(characterEmbeddings)
      .set({ hubScore: hub })
      .where(eq(characterEmbeddings.id, id));
  }

  const stats: HubStats = { k, total: all.length, byType: { character: stat } };
  log.info(stats, "corpus: character hub scores computed");
  return stats;
}

/**
 * Precompute `chat_digests.hub_score` per (tier, model) — the digest substrate's CSLS. Same exact
 * pairwise-cosine top-K mean as the corpus pass, grouped by tier so coarse consolidations aren't
 * scored against fine tier-0 digests. Idempotent; run by `pnpm csls`. Returns rows written.
 */
export async function computeDigestHubScores(db: Db, opts: { k?: number } = {}): Promise<number> {
  const k = opts.k ?? CSLS_K;
  const rows = await db
    .select({
      id: chatDigests.id,
      tier: chatDigests.tier,
      model: chatDigests.model,
      embedding: chatDigests.embedding,
    })
    .from(chatDigests);

  // Group by (tier, model) so coarse tiers aren't mixed with fine tier-0 digests.
  const groups = new Map<string, { ids: string[]; vecs: Float32Array[] }>();
  for (const r of rows) {
    if (!r.embedding) continue;
    const key = `${r.tier} ${r.model}`;
    const g = groups.get(key) ?? { ids: [], vecs: [] };
    g.ids.push(r.id);
    g.vecs.push(r.embedding);
    groups.set(key, g);
  }

  let written = 0;
  for (const { ids, vecs } of groups.values()) {
    for (const [id, hub] of computeGroupHubs(ids, vecs, k)) {
      await db.update(chatDigests).set({ hubScore: hub }).where(eq(chatDigests.id, id));
      written += 1;
    }
  }
  getLog().info({ total: rows.length, written }, "memory: digest hub scores computed");
  return written;
}

/**
 * Precompute `chat_segments.hub_score` per model — the verbatim substrate's CSLS. Idempotent;
 * run by `pnpm csls`. Returns rows written.
 */
export async function computeSegmentHubScores(db: Db, opts: { k?: number } = {}): Promise<number> {
  const k = opts.k ?? CSLS_K;
  const rows = await db
    .select({
      id: chatSegments.id,
      model: chatSegments.model,
      embedding: chatSegments.embedding,
    })
    .from(chatSegments);

  // Group by model (segments have no tier — all verbatim, same distribution).
  const groups = new Map<string, { ids: string[]; vecs: Float32Array[] }>();
  for (const r of rows) {
    if (!r.embedding) continue;
    const g = groups.get(r.model) ?? { ids: [], vecs: [] };
    g.ids.push(r.id);
    g.vecs.push(r.embedding);
    groups.set(r.model, g);
  }

  let written = 0;
  for (const { ids, vecs } of groups.values()) {
    for (const [id, hub] of computeGroupHubs(ids, vecs, k)) {
      await db.update(chatSegments).set({ hubScore: hub }).where(eq(chatSegments.id, id));
      written += 1;
    }
  }
  getLog().info({ total: rows.length, written }, "memory: segment hub scores computed");
  return written;
}
