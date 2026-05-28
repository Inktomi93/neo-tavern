// @ts-nocheck
import { readFileSync } from "node:fs";
import { RawImage } from "@huggingface/transformers";
import { createDb } from "../../src/db/client";
import { assets } from "../../src/db/schema";
import { createImageEmbedder } from "../../src/server/embeddings/image-embedder";
import { env } from "../../src/server/env";
import { createCas } from "../../src/server/storage/cas";

async function main() {
  const db = await createDb(env.DATABASE_URL);
  const embedder = createImageEmbedder();
  const cas = createCas(env.ASSETS_DIR);

  const pendingAssets = await db.select().from(assets).limit(1);
  const asset = pendingAssets[0];
  const blobPath = cas.blobPath(asset.hash);
  console.log("Blob path:", blobPath);

  const buffer = readFileSync(blobPath);
  console.log("Buffer size:", buffer.length);

  try {
    const rawImage = await RawImage.read(buffer);
    console.log("RawImage loaded:", rawImage.width, "x", rawImage.height);
    const result = await embedder.embed(rawImage as unknown);
    console.log("Result length:", result.length);
  } catch (e) {
    console.error("Extraction failed:", e);
  }
}

main().catch(console.error);
