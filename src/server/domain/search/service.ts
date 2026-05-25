import { sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { getLog } from "../../observability/logger";

export interface SearchHit {
  entityType: string;
  entityId: string;
  /** Cosine distance (0 = identical). Lower is nearer. */
  distance: number;
}

export interface SearchService {
  knn(params: { queryText: string; k?: number | undefined }): Promise<SearchHit[]>;
}

export interface SearchServiceDeps {
  embedder?: Embedder;
}

export function createSearchService(db: Db, deps: SearchServiceDeps = {}): SearchService {
  const embedder = deps.embedder ?? createEmbedder();
  return {
    async knn({ queryText, k = 10 }) {
      const embedding = await embedder.embed(queryText);
      const query = JSON.stringify(Array.from(embedding));
      // ANN-limit via the libsql_vector_idx index, then exact cosine re-rank. Joins the
      // index's rowids back to the rows. (CSLS hubness / hybrid / rerank land with the
      // real corpus — see docs/corpus-import.md.)
      const rows = await db.all<{ entityType: string; entityId: string; dist: number }>(sql`
        SELECT e.entity_type AS entityType, e.entity_id AS entityId,
               vector_distance_cos(e.embedding, vector32(${query})) AS dist
        FROM vector_top_k('embeddings_ann', vector32(${query}), ${k}) AS v
        JOIN embeddings e ON e.rowid = v.id
        ORDER BY dist ASC
      `);
      getLog().debug(
        { k, queryChars: queryText.length, hits: rows.length, nearest: rows[0]?.dist },
        "search: knn",
      );
      return rows.map((row) => ({
        entityType: row.entityType,
        entityId: row.entityId,
        distance: row.dist,
      }));
    },
  };
}
