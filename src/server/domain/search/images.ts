import { sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import type { ImageEmbedder } from "../../embeddings/image-embedder";
import type { ImageSearchHit } from "./types";

export function createSearchImages(db: Db, imageEmbedder: ImageEmbedder) {
  async function images(params: {
    queryText: string;
    k?: number | undefined;
  }): Promise<ImageSearchHit[]> {
    const { queryText, k = 10 } = params;
    const embedding = await imageEmbedder.embedText(queryText);
    const query = JSON.stringify(Array.from(embedding));

    const rows = await db.all<{
      assetId: string;
      assetHash: string;
      dist: number;
      characterId: string | null;
      characterName: string | null;
    }>(sql`
      SELECT ie.asset_id AS assetId, a.hash AS assetHash,
             vector_distance_cos(ie.embedding, vector32(${query})) AS dist,
             c.id AS characterId,
             cv.name AS characterName
      FROM vector_top_k('image_embeddings_ann', vector32(${query}), ${k}) AS v
      JOIN image_embeddings ie ON ie.rowid = v.id
      JOIN assets a ON a.id = ie.asset_id
      LEFT JOIN character_versions cv ON cv.avatar_asset_id = ie.asset_id
      LEFT JOIN characters c ON c.current_version_id = cv.id
      ORDER BY dist ASC
    `);

    return rows.map((r) => ({
      assetId: r.assetId,
      assetHash: r.assetHash,
      distance: r.dist,
      characterId: r.characterId,
      characterName: r.characterName,
    }));
  }
  return { images };
}
