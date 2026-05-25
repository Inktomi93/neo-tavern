import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characters, chats } from "../../../db/schema";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { getLog } from "../../observability/logger";

export interface SearchHit {
  entityType: string;
  entityId: string;
  /**
   * Raw cosine distance (0 = identical). Lower is nearer. NOTE: hits are ordered by the
   * CSLS-adjusted distance (hubness correction), not by this raw value — so a consumer
   * must keep the returned order, not re-sort by `distance`.
   */
  distance: number;
}

export interface SearchService {
  knn(params: {
    queryText: string;
    k?: number | undefined;
    /** When set, results are restricted to entities owned by this user (multi-user scoping). */
    ownerId?: string | undefined;
  }): Promise<SearchHit[]>;
}

export interface SearchServiceDeps {
  embedder?: Embedder;
}

// embeddings has no ownerId (denormalizing it invites drift). When scoping, over-fetch and
// resolve ownership through the entity rows. ×8 survives a filtered tail at this corpus size.
const OWNER_OVERFETCH = 8;

// CSLS hubness re-rank pool: fetch more than k so the correction can pull a non-hub from
// positions k+1..(k·F) above a demoted hub. Diverges from card-curator's CSLS-only path
// (pool = n_results, reorder-in-place) — over-fetching is cheap and is the whole point of
// hubness correction (surface the specific match). hub_score precomputed in domain/corpus.
const CSLS_POOL_FACTOR = 4;

function chatIdOf(entityId: string): string {
  return entityId.split(":")[0] ?? entityId; // chat_segment entityId = "<chatId>:<segIdx>"
}

export function createSearchService(db: Db, deps: SearchServiceDeps = {}): SearchService {
  const embedder = deps.embedder ?? createEmbedder();

  // Keep only the hits whose backing entity is owned by ownerId (character → characters,
  // chat_segment → chats). Unknown entity types are dropped under scoping.
  async function scopeToOwner(rows: SearchHit[], ownerId: string): Promise<SearchHit[]> {
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

  return {
    async knn({ queryText, k = 10, ownerId }) {
      const embedding = await embedder.embed(queryText);
      const query = JSON.stringify(Array.from(embedding));
      // Pool ≥ k for the CSLS re-rank; unioned with the owner-scope over-fetch.
      const poolK = Math.max(k * CSLS_POOL_FACTOR, ownerId ? k * OWNER_OVERFETCH : k);
      // ANN-limit via the libsql_vector_idx index, then exact cosine re-rank, joining the
      // index's rowids back to the rows. hub_score (domain/corpus, may be null) drives CSLS.
      const rows = await db.all<{
        entityType: string;
        entityId: string;
        dist: number;
        hubScore: number | null;
      }>(sql`
        SELECT e.entity_type AS entityType, e.entity_id AS entityId,
               vector_distance_cos(e.embedding, vector32(${query})) AS dist,
               e.hub_score AS hubScore
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
        hit: { entityType: row.entityType, entityId: row.entityId, distance: row.dist },
        rank: row.hubScore === null ? row.dist : Math.max(0, row.dist - 1 + row.hubScore),
      }));
      adjusted.sort((a, b) => a.rank - b.rank);
      const all = adjusted.map((a) => a.hit);
      const scoped = ownerId ? await scopeToOwner(all, ownerId) : all;
      const hits = scoped.slice(0, k);
      getLog().debug(
        {
          k,
          ownerScoped: ownerId !== undefined,
          fetched: all.length,
          hits: hits.length,
          nearest: hits[0]?.distance,
        },
        "search: knn",
      );
      return hits;
    },
  };
}
