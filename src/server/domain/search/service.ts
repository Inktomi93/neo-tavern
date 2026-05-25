import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characters, chats } from "../../../db/schema";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { getLog } from "../../observability/logger";

export interface SearchHit {
  entityType: string;
  entityId: string;
  /** Cosine distance (0 = identical). Lower is nearer. */
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
      const fetchK = ownerId ? k * OWNER_OVERFETCH : k;
      // ANN-limit via the libsql_vector_idx index, then exact cosine re-rank, joining the
      // index's rowids back to the rows. (CSLS hubness / hybrid / rerank land in 4.6.3.)
      const rows = await db.all<{ entityType: string; entityId: string; dist: number }>(sql`
        SELECT e.entity_type AS entityType, e.entity_id AS entityId,
               vector_distance_cos(e.embedding, vector32(${query})) AS dist
        FROM vector_top_k('embeddings_ann', vector32(${query}), ${fetchK}) AS v
        JOIN embeddings e ON e.rowid = v.id
        ORDER BY dist ASC
      `);
      const all: SearchHit[] = rows.map((row) => ({
        entityType: row.entityType,
        entityId: row.entityId,
        distance: row.dist,
      }));
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
