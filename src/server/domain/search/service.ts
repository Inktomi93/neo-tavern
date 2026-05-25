import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characters, chats } from "../../../db/schema";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { createReranker, type Reranker } from "../../embeddings/reranker";
import { getLog } from "../../observability/logger";

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

export interface SearchService {
  knn(params: {
    queryText: string;
    k?: number | undefined;
    /** When set, results are restricted to entities owned by this user (multi-user scoping). */
    ownerId?: string | undefined;
    /** Second stage: re-score the CSLS pool with the cross-encoder reranker (4.6.3b). */
    rerank?: boolean | undefined;
  }): Promise<SearchHit[]>;
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

// A pool candidate carries source_text (for rerank) through CSLS + owner-scoping.
interface Candidate {
  entityType: string;
  entityId: string;
  distance: number;
  sourceText: string | null;
}

function chatIdOf(entityId: string): string {
  return entityId.split(":")[0] ?? entityId; // chat_segment entityId = "<chatId>:<segIdx>"
}

export function createSearchService(db: Db, deps: SearchServiceDeps = {}): SearchService {
  const embedder = deps.embedder ?? createEmbedder();
  const reranker = deps.reranker ?? createReranker();

  // Keep only candidates whose backing entity is owned by ownerId (character → characters,
  // chat_segment → chats). Generic so it can scope the candidate pool (carrying source_text).
  async function scopeToOwner<T extends { entityType: string; entityId: string }>(
    rows: T[],
    ownerId: string,
  ): Promise<T[]> {
    const charIds = rows.filter((r) => r.entityType === "character").map((r) => r.entityId);
    const chatIds = rows
      .filter((r) => r.entityType === "chat_segment")
      .map((r) => chatIdOf(r.entityId));
    const ownedChars =
      charIds.length > 0
        ? new Set(
            (
              await db
                .select({ id: characters.id })
                .from(characters)
                .where(and(eq(characters.ownerId, ownerId), inArray(characters.id, charIds)))
            ).map((r) => r.id),
          )
        : new Set<string>();
    const ownedChats =
      chatIds.length > 0
        ? new Set(
            (
              await db
                .select({ id: chats.id })
                .from(chats)
                .where(and(eq(chats.ownerId, ownerId), inArray(chats.id, chatIds)))
            ).map((r) => r.id),
          )
        : new Set<string>();
    return rows.filter((r) => {
      if (r.entityType === "character") return ownedChars.has(r.entityId);
      if (r.entityType === "chat_segment") return ownedChats.has(chatIdOf(r.entityId));
      return false; // unknown entity type → not owner-resolvable, drop under scoping
    });
  }

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

  return {
    async knn({ queryText, k = 10, ownerId, rerank = false }) {
      const embedding = await embedder.embed(queryText);
      const query = JSON.stringify(Array.from(embedding));
      // Pool ≥ k for the CSLS re-rank + the rerank candidate set; unioned with owner over-fetch.
      const poolK = Math.max(k * CSLS_POOL_FACTOR, ownerId ? k * OWNER_OVERFETCH : k);
      // ANN-limit via the libsql_vector_idx index, then exact cosine re-rank, joining the
      // index's rowids back to the rows. hub_score (domain/corpus, may be null) drives CSLS;
      // source_text feeds the optional cross-encoder rerank.
      const rows = await db.all<{
        entityType: string;
        entityId: string;
        dist: number;
        hubScore: number | null;
        sourceText: string | null;
      }>(sql`
        SELECT e.entity_type AS entityType, e.entity_id AS entityId,
               vector_distance_cos(e.embedding, vector32(${query})) AS dist,
               e.hub_score AS hubScore, e.source_text AS sourceText
        FROM vector_top_k('embeddings_ann', vector32(${query}), ${poolK}) AS v
        JOIN embeddings e ON e.rowid = v.id
        ORDER BY dist ASC
      `);
      // CSLS hubness correction: adjusted = max(0, dist - 1 + hub_score), demoting vectors
      // that are near everything (card-curator server.py:169). null hub_score (not yet
      // precomputed) → raw distance, no adjustment. The clamp ties the top of the pool at 0;
      // V8's sort is STABLE and the pool arrives in raw-dist order, so equal-adjusted hits
      // keep their raw-distance tiebreak — do not "simplify" this to an unstable sort.
      const adjusted = rows.map((row) => ({
        cand: {
          entityType: row.entityType,
          entityId: row.entityId,
          distance: row.dist,
          sourceText: row.sourceText,
        },
        rank: row.hubScore === null ? row.dist : Math.max(0, row.dist - 1 + row.hubScore),
      }));
      adjusted.sort((a, b) => a.rank - b.rank);
      const pool = adjusted.map((a) => a.cand);
      const scoped = ownerId ? await scopeToOwner(pool, ownerId) : pool;
      const ranked = rerank ? await applyRerank(queryText, scoped) : scoped;
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
          nearest: hits[0]?.distance,
        },
        "search: knn",
      );
      return hits;
    },
  };
}
