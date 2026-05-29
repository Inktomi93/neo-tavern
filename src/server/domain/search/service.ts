import type { Db } from "../../../db/client";
import { createEmbedder } from "../../embeddings/embedder";
import { createImageEmbedder } from "../../embeddings/image-embedder";
import { createReranker } from "../../embeddings/reranker";
import { createSearchCore } from "./core";
import { createSearchImages } from "./images";
import { createSearchInternal } from "./internal";
import { createSearchMemory } from "./memory";
import type { SearchService, SearchServiceDeps } from "./types";

// No exports here to avoid barrel file lint error

export function createSearchService(db: Db, deps: SearchServiceDeps = {}): SearchService {
  const embedder = deps.embedder ?? createEmbedder();
  const imageEmbedder = deps.imageEmbedder ?? createImageEmbedder();
  const reranker = deps.reranker ?? createReranker();

  const internal = createSearchInternal(db, reranker);
  const core = createSearchCore(db, embedder, internal);
  const memory = createSearchMemory(db, embedder, reranker);
  const imgs = createSearchImages(db, imageEmbedder);

  return {
    ...core,
    ...memory,
    ...imgs,
  };
}
