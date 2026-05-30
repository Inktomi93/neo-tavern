import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterEmbeddings } from "../../../db/schema";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import {
  computeDuplicatePairs,
  type DuplicateCharacterPair,
  type DuplicateChatPair,
  type DuplicateComputeStats,
  readDuplicateCharacters,
  readDuplicateChats,
  similarCharacters,
} from "./duplicates";
import { type CharacterProfile, type CorpusStats, characterProfile, corpusStats } from "./stats";

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

  // ── analytics: near-duplicate detection (B.5) ──────────────────────────────
  /** Recompute the `duplicate_pairs` rollup (both entity types). The heavy all-pairs pass — run by
   *  scripts/find-duplicates.ts, not on a request. */
  computeDuplicatePairs(opts?: {
    threshold?: number | undefined;
    chatThreshold?: number | undefined;
    minChatMessages?: number | undefined;
  }): Promise<DuplicateComputeStats>;
  /** Owner-scoped character near-dups from the rollup (ranked by CSLS). */
  duplicateCharacters(
    username: string,
    opts?: { threshold?: number | undefined },
  ): Promise<DuplicateCharacterPair[]>;
  /** Owner-scoped chat near-dups from the rollup; `forked` pairs are a known lineage (B.5.1). */
  duplicateChats(
    username: string,
    opts?: { threshold?: number | undefined; includeForked?: boolean | undefined },
  ): Promise<DuplicateChatPair[]>;
  /** "More like this" for one character — live ANN kNN. */
  similarCharacters(
    username: string,
    characterId: string,
    limit?: number,
  ): Promise<{ characterId: string; name: string; similarity: number }[]>;
  /** Corpus dashboard — totals, per-model usage, most-RP'd characters, activity timeline (pure SQL). */
  corpusStats(username: string): Promise<CorpusStats>;
  /** One character's full aggregate profile + top keywords (tier-0, content-collapsed). */
  characterProfile(username: string, characterId: string): Promise<CharacterProfile | null>;
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

    computeDuplicatePairs(opts = {}) {
      return computeDuplicatePairs(db, opts);
    },

    async duplicateCharacters(username, opts = {}) {
      const ownerId = await ensureUser(db, username);
      return readDuplicateCharacters(db, ownerId, opts);
    },

    async duplicateChats(username, opts = {}) {
      const ownerId = await ensureUser(db, username);
      return readDuplicateChats(db, ownerId, opts);
    },

    async similarCharacters(username, characterId, limit) {
      const ownerId = await ensureUser(db, username);
      return similarCharacters(db, characterId, ownerId, limit);
    },

    async corpusStats(username) {
      const ownerId = await ensureUser(db, username);
      return corpusStats(db, ownerId);
    },

    async characterProfile(username, characterId) {
      const ownerId = await ensureUser(db, username);
      return characterProfile(db, ownerId, characterId);
    },
  };
}
