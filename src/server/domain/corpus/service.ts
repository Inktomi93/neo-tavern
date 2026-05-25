import type { Db } from "../../../db/client";
import { embeddings } from "../../../db/schema";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { newId } from "../_shared/ids";

// Embeds a piece of text and stores the vector against a (entityType, entityId). The
// importer (Phase 4) drives this over real cards/chat-segments; for now it's exercised
// directly. Indexing real entities + segmentation lands with the importer.
export interface CorpusService {
  embedAndStore(params: {
    entityType: string;
    entityId: string;
    text: string;
  }): Promise<{ id: string }>;
}

export interface CorpusServiceDeps {
  embedder?: Embedder;
}

export function createCorpusService(db: Db, deps: CorpusServiceDeps = {}): CorpusService {
  const embedder = deps.embedder ?? createEmbedder();
  return {
    async embedAndStore({ entityType, entityId, text }) {
      const embedding = await embedder.embed(text);
      const id = newId();
      await db.insert(embeddings).values({
        id,
        entityType,
        entityId,
        model: embedder.model,
        embedding,
        createdAt: Date.now(),
      });
      return { id };
    },
  };
}
