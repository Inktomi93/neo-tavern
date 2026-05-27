import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characters, characterVersions, chatSegments } from "../../../db/schema";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { createReranker, type Reranker } from "../../embeddings/reranker";
import { getLog } from "../../observability/logger";
import { ensureUser } from "../_shared/users";

export interface SearchHit {
  entityType: string;
  entityId: string;
  /**
   * Raw cosine distance (0 = identical). Lower is nearer. NOTE: hits are ordered by the
   * CSLS-adjusted distance (hubness correction) — or by cross-encoder score when `rerank` is
   * set — NOT by this raw value. A consumer must keep the returned order, not re-sort by it.
   */
  distance: number;
}

/** One conversation snippet backing a discover hit. */
export interface DiscoverSegment {
  chatId: string;
  segIndex: number;
  /** Leading slice of the embedded segment text (the supporting evidence). */
  snippet: string;
  /** Raw cosine distance of this segment to the query. */
  distance: number;
}

/** A character surfaced by discover, ranked by their single best matching segment. */
export interface DiscoverCharacter {
  characterId: string;
  name: string;
  tags: string[];
  description: string;
  /** How many pool segments matched this character. */
  matchCount: number;
  /** Raw cosine distance of the best matching segment (results are ordered by rank, which
   *  is CSLS-adjusted distance, or cross-encoder score when reranked — not this value). */
  bestDistance: number;
  segments: DiscoverSegment[];
}

/** A display-ready knn hit (tagged union — the UI switches on `kind`). Ordered by rank. */
export type FindResult =
  | { kind: "character"; entityId: string; distance: number; name: string; tags: string[] }
  | {
      kind: "segment";
      entityId: string;
      distance: number;
      characterName: string;
      chatId: string;
      segIndex: number;
      snippet: string;
    };

/** A cross-chat corpus hit over the DIGEST substrate. Ordered by CSLS-adjusted distance (or by
 *  cross-encoder score when reranked) — keep the returned order. The seq span is the click-through. */
export interface DigestSearchHit {
  chatId: string;
  characterVersionId: string;
  tier: number;
  blockIdx: number;
  seqStart: number;
  seqEnd: number;
  topicAnchor: string | null;
  /** Leading slice of the digest text (the supporting evidence). */
  snippet: string;
  /** Raw cosine distance (ordering is CSLS/rerank — do not re-sort by this). */
  distance: number;
}

/** A cross-chat corpus hit over the raw SEGMENT substrate (verbatim half of the hybrid). */
export interface SegmentSearchHit {
  chatId: string;
  characterVersionId: string;
  blockIdx: number;
  seqStart: number;
  seqEnd: number;
  /** Leading slice of the block's raw verbatim text (the supporting evidence). */
  snippet: string;
  distance: number;
}

/** One hit in the UNIFIED hybrid corpus search — a single ranked list across both substrates
 *  (structured digests + raw segments), deduped per block, joint cross-encoder reranked. `source`
 *  says which lens won the block; the seq span is the verbatim click-through. */
export interface CorpusHit {
  source: "digest" | "segment";
  chatId: string;
  characterVersionId: string;
  tier: number;
  blockIdx: number;
  seqStart: number;
  seqEnd: number;
  snippet: string;
  distance: number;
}

export interface SearchService {
  /** Lean primitive: nearest entities as (entityType, entityId, distance). */
  knn(params: {
    queryText: string;
    k?: number | undefined;
    /** When set, results are restricted to entities owned by this user (multi-user scoping). */
    ownerId?: string | undefined;
    /** Second stage: re-score the CSLS pool with the cross-encoder reranker (4.6.3b). */
    rerank?: boolean | undefined;
  }): Promise<SearchHit[]>;

  /** Display-ready knn: each hit enriched with its name / snippet (the "Find" UI mode). */
  find(params: {
    queryText: string;
    k?: number | undefined;
    ownerId?: string | undefined;
    rerank?: boolean | undefined;
  }): Promise<FindResult[]>;

  /**
   * The killer feature (4.6.3c): "who have I actually done X with?" Searches chat SEGMENTS,
   * groups by character, and returns characters ranked by their single best matching
   * conversation — with the supporting segment snippets — rather than raw segments.
   */
  discover(params: {
    queryText: string;
    k?: number | undefined;
    ownerId?: string | undefined;
    rerank?: boolean | undefined;
  }): Promise<DiscoverCharacter[]>;

  /**
   * Cross-chat corpus search over the structured DIGEST substrate (docs/memory.md §4): the same
   * within-chat memory digests, queried GLOBALLY but SCOPED to the owner. A USER-facing search tool
   * — distinct from in-character memory injection, which never crosses chats. Hits carry the canon
   * seq span for verbatim click-through.
   */
  digests(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<DigestSearchHit[]>;

  /** Cross-chat corpus search over the raw SEGMENT substrate (verbatim half of the hybrid). Same
   *  owner-scoping + CSLS + optional rerank as digests; hits carry the seq span for click-through. */
  segments(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<SegmentSearchHit[]>;

  /** The hybrid "mix" — ONE ranked list over both substrates (digests = theme, segments =
   *  verbatim), deduped per block, joint cross-encoder reranked across the two lenses. */
  corpus(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<CorpusHit[]>;
}

export interface SearchServiceDeps {
  embedder?: Embedder;
  reranker?: Reranker;
}

// embeddings has no ownerId (denormalizing it invites drift). When scoping, over-fetch and
// resolve ownership through the entity rows. ×8 survives a filtered tail at this corpus size.
const OWNER_OVERFETCH = 8;

// CSLS hubness re-rank pool: fetch more than k so the correction can pull a non-hub from
// positions k+1..(k·F) above a demoted hub. Diverges from card-curator's CSLS-only path
// (pool = n_results, reorder-in-place) — over-fetching is cheap and is the whole point of
// hubness correction (surface the specific match). Also the candidate pool the cross-encoder
// reranker re-scores (card-curator uses n*3; k*4 is comparable). hub_score in domain/corpus.
const CSLS_POOL_FACTOR = 4;

// discover groups a big SEGMENT pool by character, so it needs many more candidates than knn
// — a heavy-tailed corpus (a popular card owns 100+ segments) means k characters need ~k·20
// segments represented. Capped near the ANN budget ceiling (vector_top_k returns only a few
// hundred for a large request — docs/conventions.md); bail to whatever covered if fewer.
const DISCOVER_SEGMENT_POOL_FACTOR = 20;
const DISCOVER_SEGMENT_POOL_CAP = 400;
const DISCOVER_SEGMENTS_PER_CHAR = 3; // best + up to 2 more for drill-down evidence
const SNIPPET_CHARS = 280; // segment text can be ~8KB; a snippet is enough evidence

// A pool candidate carries source_text (for rerank) through CSLS + owner-scoping.
interface Candidate {
  entityType: string;
  entityId: string;
  distance: number;
  sourceText: string | null;
}

interface SegmentDisplay {
  characterId: string;
  name: string;
  tags: string[];
  description: string;
  chatId: string;
  segIndex: number;
  snippet: string;
}

function chatIdOf(entityId: string): string {
  return entityId.split(":")[0] ?? entityId; // chat_segment entityId = "<chatId>:<segIdx>"
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function createSearchService(db: Db, deps: SearchServiceDeps = {}): SearchService {
  const embedder = deps.embedder ?? createEmbedder();
  const reranker = deps.reranker ?? createReranker();

  // Keep only candidates whose backing entity is owned by ownerId (character → characters,
  // chat_segment → chats). Generic so it can scope the candidate pool (carrying source_text).

  // Stage 2: cross-encoder rerank. Reorders the (owner-scoped, CSLS-ranked) pool by joint
  // (query, source_text) relevance. Candidates without source_text can't be scored — they're
  // left in their CSLS position AFTER the reranked ones (not silently dropped from results).
  async function applyRerank(queryText: string, pool: Candidate[]): Promise<Candidate[]> {
    const scorable = pool.filter((c) => c.sourceText !== null);
    const dropped = pool.length - scorable.length;
    if (dropped > 0) {
      getLog().debug({ dropped }, "search: rerank skipped candidates without source_text");
    }
    if (scorable.length === 0) return pool;
    const scores = await reranker.rerank(
      queryText,
      scorable.map((c) => ({ id: c.entityId, text: c.sourceText ?? "" })),
    );
    const orderByEntityId = new Map(scores.map((s, idx) => [s.id, idx]));
    // Stable sort: scored candidates in reranker order; unscorable ones (Infinity) keep their
    // CSLS order at the tail.
    return [...pool].sort(
      (a, b) =>
        (orderByEntityId.get(a.entityId) ?? Number.POSITIVE_INFINITY) -
        (orderByEntityId.get(b.entityId) ?? Number.POSITIVE_INFINITY),
    );
  }

  // Resolve segment entityIds ("<chatId>:<blockIdx>") → the owning character's card + the block's
  // raw snippet, reading the first-class chat_segments table (Phase B — segments left the polymorphic
  // embeddings table). owner_id is a direct column, so an optional ownerId scopes without a chats
  // join. Shared by discover (grouping) and find (segment rows).
  async function resolveSegmentDisplay(
    entityIds: string[],
    ownerId?: string,
  ): Promise<Map<string, SegmentDisplay>> {
    const out = new Map<string, SegmentDisplay>();
    const chatIds = [...new Set(entityIds.map(chatIdOf))];
    if (chatIds.length === 0) return out;
    const segRows = await db
      .select({
        chatId: chatSegments.chatId,
        blockIdx: chatSegments.blockIdx,
        cvId: chatSegments.characterVersionId,
        text: chatSegments.text,
      })
      .from(chatSegments)
      .where(
        ownerId
          ? and(eq(chatSegments.ownerId, ownerId), inArray(chatSegments.chatId, chatIds))
          : inArray(chatSegments.chatId, chatIds),
      );
    if (segRows.length === 0) return out;
    const cvIds = [...new Set(segRows.map((r) => r.cvId))];
    const cvRows = await db
      .select({
        id: characterVersions.id,
        characterId: characterVersions.characterId,
        name: characterVersions.name,
        tags: characterVersions.tags,
        description: characterVersions.description,
      })
      .from(characterVersions)
      .where(inArray(characterVersions.id, cvIds));
    const cvById = new Map(cvRows.map((r) => [r.id, r]));
    for (const r of segRows) {
      const cv = cvById.get(r.cvId);
      if (!cv) continue;
      out.set(`${r.chatId}:${r.blockIdx}`, {
        characterId: cv.characterId,
        name: cv.name,
        tags: asStringArray(cv.tags),
        description: cv.description,
        chatId: r.chatId,
        segIndex: r.blockIdx,
        snippet: (r.text ?? "").slice(0, SNIPPET_CHARS),
      });
    }
    return out;
  }

  // Resolve characterIds → their CURRENT-version card (name + tags) for find's character rows.
  async function resolveCharacterDisplay(
    charIds: string[],
  ): Promise<Map<string, { name: string; tags: string[] }>> {
    const out = new Map<string, { name: string; tags: string[] }>();
    if (charIds.length === 0) return out;
    const charRows = await db
      .select({ id: characters.id, cvId: characters.currentVersionId })
      .from(characters)
      .where(inArray(characters.id, charIds));
    const cvIds = charRows.map((r) => r.cvId).filter((x): x is string => x !== null);
    if (cvIds.length === 0) return out;
    const cvRows = await db
      .select({
        id: characterVersions.id,
        name: characterVersions.name,
        tags: characterVersions.tags,
      })
      .from(characterVersions)
      .where(inArray(characterVersions.id, cvIds));
    const cvById = new Map(cvRows.map((r) => [r.id, r]));
    for (const c of charRows) {
      if (c.cvId === null) continue;
      const cv = cvById.get(c.cvId);
      if (cv) out.set(c.id, { name: cv.name, tags: asStringArray(cv.tags) });
    }
    return out;
  }

  async function knn(params: {
    queryText: string;
    k?: number | undefined;
    ownerId?: string | undefined;
    rerank?: boolean | undefined;
  }): Promise<SearchHit[]> {
    const { queryText, k = 10, ownerId, rerank = false } = params;
    const embedding = await embedder.embed(queryText);
    const query = JSON.stringify(Array.from(embedding));
    // Pool ≥ k for the CSLS re-rank + the rerank candidate set; unioned with owner over-fetch.
    const poolK = Math.max(k * CSLS_POOL_FACTOR, ownerId ? k * OWNER_OVERFETCH : k);
    // Two ANN queries unioned into one CSLS-ranked pool: characters from character_embeddings,
    // segments from chat_segments. BOTH carry a denormalized owner_id, so scope is a direct WHERE
    // on the joined row (the old polymorphic over-fetch + scopeToOwner join-back is retired).
    const ownerFilter = (col: string) =>
      ownerId ? sql`WHERE ${sql.raw(col)} = ${ownerId}` : sql``;
    const charRows = await db.all<{
      entityId: string;
      dist: number;
      hubScore: number | null;
      sourceText: string | null;
    }>(sql`
      SELECT ce.character_id AS entityId,
             vector_distance_cos(ce.embedding, vector32(${query})) AS dist,
             ce.hub_score AS hubScore, ce.source_text AS sourceText
      FROM vector_top_k('character_embeddings_ann', vector32(${query}), ${poolK}) AS v
      JOIN character_embeddings ce ON ce.rowid = v.id
      ${ownerFilter("ce.owner_id")}
      ORDER BY dist ASC
    `);
    const segRows = await db.all<{
      chatId: string;
      blockIdx: number;
      dist: number;
      hubScore: number | null;
      text: string;
    }>(sql`
      SELECT cs.chat_id AS chatId, cs.block_idx AS blockIdx,
             vector_distance_cos(cs.embedding, vector32(${query})) AS dist,
             cs.hub_score AS hubScore, cs.text AS text
      FROM vector_top_k('chat_segments_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_segments cs ON cs.rowid = v.id
      ${ownerFilter("cs.owner_id")}
      ORDER BY dist ASC
    `);
    // CSLS hubness correction: adjusted = max(0, dist - 1 + hub_score), demoting near-everything
    // vectors. null hub_score → raw distance. Stable sort keeps the raw-distance tiebreak.
    const csls = (dist: number, hub: number | null): number =>
      hub === null ? dist : Math.max(0, dist - 1 + hub);
    const scored = [
      ...charRows.map((r) => ({
        cand: {
          entityType: "character",
          entityId: r.entityId,
          distance: r.dist,
          sourceText: r.sourceText,
        },
        rank: csls(r.dist, r.hubScore),
      })),
      ...segRows.map((r) => ({
        cand: {
          entityType: "chat_segment",
          entityId: `${r.chatId}:${r.blockIdx}`,
          distance: r.dist,
          sourceText: r.text,
        },
        rank: csls(r.dist, r.hubScore),
      })),
    ];
    scored.sort((a, b) => a.rank - b.rank);
    const pool = scored.map((a) => a.cand);
    // Owner scoping now lives in the SQL (direct owner_id WHERE), so the pool is already scoped.
    const ranked = rerank ? await applyRerank(queryText, pool) : pool;
    const hits: SearchHit[] = ranked
      .slice(0, k)
      .map((c) => ({ entityType: c.entityType, entityId: c.entityId, distance: c.distance }));
    getLog().debug(
      {
        k,
        ownerScoped: ownerId !== undefined,
        reranked: rerank,
        fetched: pool.length,
        hits: hits.length,
      },
      "search: knn",
    );
    return hits;
  }

  async function find(params: {
    queryText: string;
    k?: number | undefined;
    ownerId?: string | undefined;
    rerank?: boolean | undefined;
  }): Promise<FindResult[]> {
    const hits = await knn(params); // already CSLS/rerank-ordered + owner-scoped
    const charIds = hits.filter((h) => h.entityType === "character").map((h) => h.entityId);
    const segIds = hits.filter((h) => h.entityType === "chat_segment").map((h) => h.entityId);
    const [charMap, segMap] = await Promise.all([
      resolveCharacterDisplay(charIds),
      resolveSegmentDisplay(segIds),
    ]);
    const results: FindResult[] = [];
    for (const h of hits) {
      if (h.entityType === "character") {
        const c = charMap.get(h.entityId);
        if (c) {
          results.push({
            kind: "character",
            entityId: h.entityId,
            distance: h.distance,
            name: c.name,
            tags: c.tags,
          });
        }
      } else if (h.entityType === "chat_segment") {
        const s = segMap.get(h.entityId);
        if (s) {
          results.push({
            kind: "segment",
            entityId: h.entityId,
            distance: h.distance,
            characterName: s.name,
            chatId: s.chatId,
            segIndex: s.segIndex,
            snippet: s.snippet,
          });
        }
      }
    }
    getLog().debug(
      { results: results.length, characters: charIds.length, segments: segIds.length },
      "search: find (enriched)",
    );
    return results;
  }

  async function discover(params: {
    queryText: string;
    k?: number | undefined;
    ownerId?: string | undefined;
    rerank?: boolean | undefined;
  }): Promise<DiscoverCharacter[]> {
    const { queryText, k = 10, ownerId, rerank = false } = params;
    const embedding = await embedder.embed(queryText);
    const query = JSON.stringify(Array.from(embedding));
    const poolK = Math.min(k * DISCOVER_SEGMENT_POOL_FACTOR, DISCOVER_SEGMENT_POOL_CAP);
    // Segment pool from the first-class chat_segments table (Phase B), CSLS-rankable + rerankable.
    const rows = await db.all<{
      chatId: string;
      blockIdx: number;
      dist: number;
      hubScore: number | null;
      text: string;
    }>(sql`
      SELECT cs.chat_id AS chatId, cs.block_idx AS blockIdx,
             vector_distance_cos(cs.embedding, vector32(${query})) AS dist,
             cs.hub_score AS hubScore, cs.text AS text
      FROM vector_top_k('chat_segments_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_segments cs ON cs.rowid = v.id
      ORDER BY dist ASC
    `);
    const pool: Candidate[] = rows
      .map((row) => ({
        cand: {
          entityType: "chat_segment",
          entityId: `${row.chatId}:${row.blockIdx}`,
          distance: row.dist,
          sourceText: row.text,
        },
        rank: row.hubScore === null ? row.dist : Math.max(0, row.dist - 1 + row.hubScore),
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.cand);
    // Rerank the SEGMENTS (independent of grouping) before grouping — a segment the reranker
    // promotes can pull in a character CSLS ranked low.
    const ranked = rerank ? await applyRerank(queryText, pool) : pool;

    const display = await resolveSegmentDisplay(
      ranked.map((c) => c.entityId),
      ownerId,
    );
    // Group by character in ranked order — first appearance = best segment. Map preserves
    // insertion order, so iterating values() yields characters already ranked by best match.
    const byChar = new Map<string, DiscoverCharacter>();
    for (const c of ranked) {
      const d = display.get(c.entityId);
      if (!d) continue; // chat not owned / unresolved → dropped
      const seg: DiscoverSegment = {
        chatId: d.chatId,
        segIndex: d.segIndex,
        snippet: (c.sourceText ?? "").slice(0, SNIPPET_CHARS),
        distance: c.distance,
      };
      const existing = byChar.get(d.characterId);
      if (existing) {
        existing.matchCount += 1;
        if (existing.segments.length < DISCOVER_SEGMENTS_PER_CHAR) existing.segments.push(seg);
      } else {
        byChar.set(d.characterId, {
          characterId: d.characterId,
          name: d.name,
          tags: d.tags,
          description: d.description,
          matchCount: 1,
          bestDistance: c.distance,
          segments: [seg],
        });
      }
    }
    const result = [...byChar.values()].slice(0, k);
    getLog().debug(
      { k, reranked: rerank, pool: ranked.length, characters: result.length },
      "search: discover",
    );
    return result;
  }

  // Cross-chat corpus search over the DIGEST substrate. chat_digests HAS owner_id, so scoping is a
  // WHERE (no post-fetch ownership resolve like the polymorphic embeddings path). Digest hub scores
  // aren't computed yet, so CSLS is null-safe / raw distance today; the rerank still sharpens order.
  async function digests(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<DigestSearchHit[]> {
    const { queryText, k = 10, rerank = false } = params;
    const ownerId = await ensureUser(db, params.username);
    const embedding = await embedder.embed(queryText);
    const query = JSON.stringify(Array.from(embedding));
    const poolK = Math.max(k * CSLS_POOL_FACTOR, k * OWNER_OVERFETCH);
    const rows = await db.all<{
      chatId: string;
      characterVersionId: string;
      tier: number;
      blockIdx: number;
      seqStart: number;
      seqEnd: number;
      topicAnchor: string | null;
      text: string;
      dist: number;
      hubScore: number | null;
    }>(sql`
      SELECT cd.chat_id AS chatId, cd.character_version_id AS characterVersionId,
             cd.tier AS tier, cd.block_idx AS blockIdx,
             cd.seq_start AS seqStart, cd.seq_end AS seqEnd,
             cd.topic_anchor AS topicAnchor, cd.text AS text,
             vector_distance_cos(cd.embedding, vector32(${query})) AS dist,
             cd.hub_score AS hubScore
      FROM vector_top_k('chat_digests_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_digests cd ON cd.rowid = v.id
      WHERE cd.owner_id = ${ownerId}
      ORDER BY dist ASC
    `);
    // CSLS hubness correction (same formula as knn; null hub_score → raw distance).
    const adjusted = rows.map((row) => ({
      row,
      rank: row.hubScore === null ? row.dist : Math.max(0, row.dist - 1 + row.hubScore),
    }));
    adjusted.sort((a, b) => a.rank - b.rank);
    let pool = adjusted.map((a) => a.row);
    const idOf = (r: (typeof pool)[number]): string => `${r.chatId}:${r.tier}:${r.blockIdx}`;
    if (rerank && pool.length > 0) {
      const scores = await reranker.rerank(
        queryText,
        pool.map((r) => ({ id: idOf(r), text: r.text })),
      );
      const order = new Map(scores.map((s, i) => [s.id, i]));
      pool = [...pool].sort(
        (a, b) =>
          (order.get(idOf(a)) ?? Number.POSITIVE_INFINITY) -
          (order.get(idOf(b)) ?? Number.POSITIVE_INFINITY),
      );
    }
    const hits: DigestSearchHit[] = pool.slice(0, k).map((r) => ({
      chatId: r.chatId,
      characterVersionId: r.characterVersionId,
      tier: r.tier,
      blockIdx: r.blockIdx,
      seqStart: r.seqStart,
      seqEnd: r.seqEnd,
      topicAnchor: r.topicAnchor,
      snippet: r.text.slice(0, SNIPPET_CHARS),
      distance: r.dist,
    }));
    getLog().debug(
      { k, reranked: rerank, fetched: pool.length, hits: hits.length },
      "search: digests",
    );
    return hits;
  }

  // Cross-chat search over the raw SEGMENT substrate — the verbatim half of the hybrid. Mirrors
  // digests(): owner-scoped WHERE (chat_segments has owner_id), CSLS-null-safe, optional rerank.
  async function segments(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<SegmentSearchHit[]> {
    const { queryText, k = 10, rerank = false } = params;
    const ownerId = await ensureUser(db, params.username);
    const embedding = await embedder.embed(queryText);
    const query = JSON.stringify(Array.from(embedding));
    const poolK = Math.max(k * CSLS_POOL_FACTOR, k * OWNER_OVERFETCH);
    const rows = await db.all<{
      chatId: string;
      characterVersionId: string;
      blockIdx: number;
      seqStart: number;
      seqEnd: number;
      text: string;
      dist: number;
      hubScore: number | null;
    }>(sql`
      SELECT cs.chat_id AS chatId, cs.character_version_id AS characterVersionId,
             cs.block_idx AS blockIdx, cs.seq_start AS seqStart, cs.seq_end AS seqEnd, cs.text AS text,
             vector_distance_cos(cs.embedding, vector32(${query})) AS dist,
             cs.hub_score AS hubScore
      FROM vector_top_k('chat_segments_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_segments cs ON cs.rowid = v.id
      WHERE cs.owner_id = ${ownerId}
      ORDER BY dist ASC
    `);
    const adjusted = rows.map((row) => ({
      row,
      rank: row.hubScore === null ? row.dist : Math.max(0, row.dist - 1 + row.hubScore),
    }));
    adjusted.sort((a, b) => a.rank - b.rank);
    let pool = adjusted.map((a) => a.row);
    const idOf = (r: (typeof pool)[number]): string => `${r.chatId}:${r.blockIdx}`;
    if (rerank && pool.length > 0) {
      const scores = await reranker.rerank(
        queryText,
        pool.map((r) => ({ id: idOf(r), text: r.text })),
      );
      const order = new Map(scores.map((s, i) => [s.id, i]));
      pool = [...pool].sort(
        (a, b) =>
          (order.get(idOf(a)) ?? Number.POSITIVE_INFINITY) -
          (order.get(idOf(b)) ?? Number.POSITIVE_INFINITY),
      );
    }
    const hits: SegmentSearchHit[] = pool.slice(0, k).map((r) => ({
      chatId: r.chatId,
      characterVersionId: r.characterVersionId,
      blockIdx: r.blockIdx,
      seqStart: r.seqStart,
      seqEnd: r.seqEnd,
      snippet: r.text.slice(0, SNIPPET_CHARS),
      distance: r.dist,
    }));
    getLog().debug(
      { k, reranked: rerank, fetched: pool.length, hits: hits.length },
      "search: segments",
    );
    return hits;
  }

  // The hybrid "mix" as a UNIFIED single ranked list: pool candidates from BOTH substrates
  // (digests = theme/precision, segments = verbatim), owner-scoped; rank the COMBINED pool by a
  // joint cross-encoder rerank over full text (the unifier across the two lenses — or CSLS-adjusted
  // distance when rerank is off, comparable since both are cosine); dedupe per block, keeping the
  // better-ranked lens; cap at k. Hits carry the seq span for verbatim click-through.
  async function corpus(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<CorpusHit[]> {
    const { queryText, k = 10, rerank = true } = params;
    const ownerId = await ensureUser(db, params.username);
    const embedding = await embedder.embed(queryText);
    const query = JSON.stringify(Array.from(embedding));
    const poolK = Math.max(k * CSLS_POOL_FACTOR, k * OWNER_OVERFETCH);
    const digRows = await db.all<{
      chatId: string;
      characterVersionId: string;
      tier: number;
      blockIdx: number;
      seqStart: number;
      seqEnd: number;
      text: string;
      dist: number;
      hubScore: number | null;
    }>(sql`
      SELECT cd.chat_id AS chatId, cd.character_version_id AS characterVersionId, cd.tier AS tier,
             cd.block_idx AS blockIdx, cd.seq_start AS seqStart, cd.seq_end AS seqEnd, cd.text AS text,
             vector_distance_cos(cd.embedding, vector32(${query})) AS dist, cd.hub_score AS hubScore
      FROM vector_top_k('chat_digests_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_digests cd ON cd.rowid = v.id
      WHERE cd.owner_id = ${ownerId}
      ORDER BY dist ASC
    `);
    const segRows = await db.all<{
      chatId: string;
      characterVersionId: string;
      blockIdx: number;
      seqStart: number;
      seqEnd: number;
      text: string;
      dist: number;
      hubScore: number | null;
    }>(sql`
      SELECT cs.chat_id AS chatId, cs.character_version_id AS characterVersionId,
             cs.block_idx AS blockIdx, cs.seq_start AS seqStart, cs.seq_end AS seqEnd, cs.text AS text,
             vector_distance_cos(cs.embedding, vector32(${query})) AS dist, cs.hub_score AS hubScore
      FROM vector_top_k('chat_segments_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_segments cs ON cs.rowid = v.id
      WHERE cs.owner_id = ${ownerId}
      ORDER BY dist ASC
    `);
    const csls = (dist: number, hub: number | null): number =>
      hub === null ? dist : Math.max(0, dist - 1 + hub);
    type Cand = CorpusHit & { rank: number; text: string };
    const cands: Cand[] = [
      ...digRows.map((r) => ({
        source: "digest" as const,
        chatId: r.chatId,
        characterVersionId: r.characterVersionId,
        tier: r.tier,
        blockIdx: r.blockIdx,
        seqStart: r.seqStart,
        seqEnd: r.seqEnd,
        snippet: r.text.slice(0, SNIPPET_CHARS),
        distance: r.dist,
        rank: csls(r.dist, r.hubScore),
        text: r.text,
      })),
      ...segRows.map((r) => ({
        source: "segment" as const,
        chatId: r.chatId,
        characterVersionId: r.characterVersionId,
        tier: 0,
        blockIdx: r.blockIdx,
        seqStart: r.seqStart,
        seqEnd: r.seqEnd,
        snippet: r.text.slice(0, SNIPPET_CHARS),
        distance: r.dist,
        rank: csls(r.dist, r.hubScore),
        text: r.text,
      })),
    ];
    const rerankId = (c: Cand): string => `${c.source}:${c.chatId}:${c.tier}:${c.blockIdx}`;
    if (rerank && cands.length > 0) {
      const scores = await reranker.rerank(
        queryText,
        cands.map((c) => ({ id: rerankId(c), text: c.text })),
      );
      const order = new Map(scores.map((s, i) => [s.id, i]));
      cands.sort(
        (a, b) =>
          (order.get(rerankId(a)) ?? Number.POSITIVE_INFINITY) -
          (order.get(rerankId(b)) ?? Number.POSITIVE_INFINITY),
      );
    } else {
      cands.sort((a, b) => a.rank - b.rank);
    }
    // Dedupe per block (chatId, tier, blockIdx) — a tier-0 block's digest + segment collapse to the
    // better-ranked lens; keep the first occurrence in ranked order. Cap at k.
    const seen = new Set<string>();
    const out: CorpusHit[] = [];
    for (const c of cands) {
      const key = `${c.chatId}:${c.tier}:${c.blockIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        source: c.source,
        chatId: c.chatId,
        characterVersionId: c.characterVersionId,
        tier: c.tier,
        blockIdx: c.blockIdx,
        seqStart: c.seqStart,
        seqEnd: c.seqEnd,
        snippet: c.snippet,
        distance: c.distance,
      });
      if (out.length >= k) break;
    }
    getLog().debug(
      { k, reranked: rerank, digests: digRows.length, segments: segRows.length, hits: out.length },
      "search: corpus (hybrid)",
    );
    return out;
  }

  return { knn, find, discover, digests, segments, corpus };
}
