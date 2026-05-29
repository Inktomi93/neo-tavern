import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterEmbeddings } from "../../../db/schema";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";

// Embeds a character card and stores the vector in the owner-keyed `character_embeddings` table
// (relational: characterId / ownerId / characterVersionId FKs). The embed pass (scripts/embed-corpus)
// drives this over every character's current-version card. (Chat segments are NOT here — they're the
// first-class chat_segments table, generated live per-block by domain/chat/memory.ts.)
//
// PLAIN insert + caller-side skip (`existingKeys`) for a RESUMABLE pass — skip the expensive embed for
// already-indexed characters. The `libsql_vector_idx` supports UPSERT/targeted-DELETE fine (verified).
// Re-embed a CHANGED card = targeted `DELETE WHERE character_id = ?` + re-insert. A FULL wipe goes
// through `clearVectorTable` (db/vector-ops.ts) — drop→delete→recreate the ANN index — because a bare
// bulk `DELETE FROM` trips SQLite's truncate optimization and poisons the DiskANN shadow table (next
// insert fails "shadow row"; `reindexAnn` / the boot health check recover a poisoned one). The
// unique(characterId, model) index makes an un-skipped duplicate error loudly.
export interface EmbedItem {
  characterId: string;
  ownerId: string;
  characterVersionId: string;
  text: string;
}

export interface CorpusService {
  readonly model: string;
  embedAndStore(item: EmbedItem): Promise<{ id: string }>;
  /** Batched: embeds all texts in one GPU pass + inserts them in one statement. The
   *  GPU-throughput path for the embed pass (caller pre-skips already-indexed characters). */
  embedAndStoreMany(items: EmbedItem[]): Promise<number>;
  /** characterIds already embedded for `model` — for resumable passes. */
  existingKeys(model?: string): Promise<Set<string>>;
}

export interface CorpusServiceDeps {
  embedder?: Embedder;
}

export function createCorpusService(db: Db, deps: CorpusServiceDeps = {}): CorpusService {
  const embedder = deps.embedder ?? createEmbedder();
  return {
    model: embedder.model,

    async embedAndStore({ characterId, ownerId, characterVersionId, text }) {
      const embedding = await embedder.embed(text);
      const id = newId();
      await db.insert(characterEmbeddings).values({
        id,
        characterId,
        ownerId,
        characterVersionId,
        model: embedder.model,
        embedding,
        sourceText: text, // the reranker (4.6.3b) scores (query, this text) pairs
        createdAt: Date.now(),
      });
      return { id };
    },

    async embedAndStoreMany(items) {
      if (items.length === 0) return 0;
      const vecs = await embedder.embedBatch(items.map((i) => i.text));
      const now = Date.now();
      const rows = items.map((it, idx) => {
        const embedding = vecs[idx];
        if (!embedding) throw new Error(`embedBatch returned no vector for item ${idx}`);
        return {
          id: newId(),
          characterId: it.characterId,
          ownerId: it.ownerId,
          characterVersionId: it.characterVersionId,
          model: embedder.model,
          embedding,
          sourceText: it.text, // reranker doc text (4.6.3b)
          createdAt: now,
        };
      });
      await db.insert(characterEmbeddings).values(rows); // multi-row plain insert (no upsert/delete)
      getLog().debug({ count: rows.length, model: embedder.model }, "corpus: embedded batch");
      return rows.length;
    },

    async existingKeys(model = embedder.model) {
      const rows = await db
        .select({ characterId: characterEmbeddings.characterId })
        .from(characterEmbeddings)
        .where(eq(characterEmbeddings.model, model));
      return new Set(rows.map((r) => r.characterId));
    },
  };
}
