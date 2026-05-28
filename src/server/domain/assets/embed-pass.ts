import { resolve } from "node:path";

import { and, eq, notExists } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { assets, imageEmbeddings } from "../../../db/schema";
import { createImageEmbedder } from "../../embeddings/image-embedder";
import { getLog } from "../../observability/logger";
import { createCas } from "../../storage/cas";

export async function runImageEmbedPass(db: Db, casRootDir: string) {
  const embedder = createImageEmbedder();
  const log = getLog();
  log.info({ model: embedder.model }, "embed-pass: starting image embed pass");

  const cas = createCas(casRootDir);

  // Find assets (like avatars) that do not yet have an embedding for this model
  const pendingAssets = await db
    .select({
      id: assets.id,
      hash: assets.hash,
      mime: assets.mime,
    })
    .from(assets)
    .where(
      notExists(
        db
          .select()
          .from(imageEmbeddings)
          .where(
            and(eq(imageEmbeddings.assetId, assets.id), eq(imageEmbeddings.model, embedder.model)),
          ),
      ),
    );

  log.info(
    { count: pendingAssets.length, model: embedder.model },
    "embed-pass: assets pending embedding",
  );

  for (const asset of pendingAssets) {
    try {
      // 1. Get the absolute path to the blob
      const blobPath = cas.blobPath(asset.hash);
      const absolutePath = resolve(blobPath);

      // 2. Extract features using the absolute file path directly
      const embeddingArray = await embedder.embed(absolutePath);

      // 3. Insert into the image_embeddings table
      await db.insert(imageEmbeddings).values({
        id: crypto.randomUUID(),
        assetId: asset.id,
        model: embedder.model,
        embedding: embeddingArray,
        createdAt: Date.now(),
      });

      log.info({ assetId: asset.id, model: embedder.model }, "embed-pass: asset embedded");
    } catch (err) {
      log.error(
        { assetId: asset.id, model: embedder.model, err },
        "embed-pass: failed to embed asset",
      );
    }
  }

  log.info({ model: embedder.model }, "embed-pass: pass complete");
}
