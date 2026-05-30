import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterEmbeddings } from "../../../db/schema";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { createSummarizer } from "../../embeddings/summarizer";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import { askCard, compareCharactersDeep, type DeepComparison } from "./analyze";
import { type Archetype, characterArchetypes } from "./archetypes";
import {
  type CatalogStats,
  type CharacterComparison,
  catalogStats,
  compareCharacters,
} from "./catalog";
import {
  type CooccurrenceStats,
  characterKeywords,
  computeCooccurrence,
  cooccurringKeywords,
  topKeywords,
} from "./cooccurrence";
import {
  type BrowseCharacter,
  type BrowseFilter,
  browseCharacters,
  characterFacets,
  computeCharacterSummaries,
  type DistillStats,
} from "./distill";
import {
  computeDuplicatePairs,
  type DuplicateCharacterPair,
  type DuplicateChatPair,
  type DuplicateComputeStats,
  readDuplicateCharacters,
  readDuplicateChats,
} from "./duplicates";
import type { EmbedItem } from "./embed-text";
import {
  type ForgottenGem,
  forgottenGems,
  type ModelRouting,
  modelRouting,
  type ThemeDriftBucket,
  themeDrift,
} from "./insights";
import {
  characterSimilarityGraph,
  type SimilarChat,
  type SimilarityGraph,
  similarChats,
} from "./similarity";
import { type SwipeInsights, swipeInsights } from "./swipes";
import {
  type ApplyTagsResult,
  applyTagSuggestions,
  type TagSuggestion,
  tagSuggestions,
} from "./tag-suggest";
import { type ThemeRow, themes } from "./themes";
import {
  type CharacterDossier,
  characterDossier,
  type HomeView,
  homeView,
  type ThemeDetail,
  themeDetail,
} from "./views";

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
export type { EmbedItem };

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

  // ── analytics: keyword co-occurrence (Pillar A, B.3) ───────────────────────
  /** Recompute the co-occurrence + character-keyword rollups (script-driven). */
  computeCooccurrence(opts?: {
    maxPairs?: number | undefined;
    hubFraction?: number | undefined;
  }): Promise<CooccurrenceStats>;
  /** Most frequent scene keywords across the owner's corpus. */
  topKeywords(
    username: string,
    opts?: { limit?: number | undefined; minCount?: number | undefined },
  ): Promise<{ keyword: string; count: number }[]>;
  /** Keywords that most often co-occur with `keyword` in a scene (+ sample characterIds to drill into). */
  cooccurringKeywords(
    username: string,
    keyword: string,
    limit?: number,
  ): Promise<{ keyword: string; count: number; characterIds: string[] }[]>;
  /** Top keywords for one character. */
  characterKeywords(
    username: string,
    characterId: string,
    limit?: number,
  ): Promise<{ keyword: string; count: number }[]>;

  // ── analytics: emergent themes (Pillar B, B.4) ─────────────────────────────
  /** All themes (k-means clusters) at a level (scene|arc), largest first. */
  themes(username: string, level?: "scene" | "arc"): Promise<ThemeRow[]>;

  // ── analytics: similarity graph + "more like this" (B.6) ───────────────────
  /** Character similarity graph (nodes + edges) for a force-directed view. */
  similarityGraph(
    username: string,
    opts?: { minSimilarity?: number | undefined; maxNodes?: number | undefined },
  ): Promise<SimilarityGraph>;
  /** Chats most similar to a given chat, by segment-centroid cosine. */
  similarChats(username: string, chatId: string, limit?: number): Promise<SimilarChat[]>;

  // ── analytics: character distillation + browse (B.0) ───────────────────────
  /** Recompute every character's grammar-constrained distillation (script-driven). */
  computeCharacterSummaries(): Promise<DistillStats>;
  /** The filterable character catalog — distillation facets + engagement, filtered/sorted. */
  browseCharacters(username: string, filter?: BrowseFilter): Promise<BrowseCharacter[]>;
  /** Distinct genres/tones present (for filter dropdowns). */
  characterFacets(username: string): Promise<{
    genres: { value: string; count: number }[];
    tones: { value: string; count: number }[];
  }>;

  // ── composed page views (the unified front-end surface) ────────────────────
  /** The corpus home — most-RP'd + activity + top scene/arc themes + cleanup counts (one call). */
  home(username: string): Promise<HomeView>;
  /** A character page — profile + distillation + keywords + scene/arc themes + similar (one call). */
  characterDossier(username: string, characterId: string): Promise<CharacterDossier | null>;
  /** One theme's detail — facets + story-time timeline + top characters (one call). */
  themeDetail(
    username: string,
    clusterIdx: number,
    level: "scene" | "arc",
  ): Promise<ThemeDetail | null>;
  /** Swipe/re-roll insights — most re-rolled moments + which characters/models make you re-roll. */
  swipes(username: string): Promise<SwipeInsights>;
  /** Distill-powered catalog — collected-vs-played by genre/tone, top tags, tag co-occurrence. */
  catalog(username: string): Promise<CatalogStats>;
  /** Compare two characters by distilled facets — a no-LLM `compare_cards` (pairs with dedup). */
  compareCharacters(
    username: string,
    characterIdA: string,
    characterIdB: string,
  ): Promise<CharacterComparison | null>;
  /** Character archetypes — cluster card embeddings, labeled by dominant distilled facets. */
  archetypes(username: string, k?: number): Promise<Archetype[]>;
  /** Forgotten gems — characters you invested in but haven't touched recently (revisit candidates). */
  forgottenGems(username: string, limit?: number): Promise<ForgottenGem[]>;
  /** Which model you reach for per genre. */
  modelRouting(username: string): Promise<ModelRouting[]>;
  /** How your themes shift over story time (drift). */
  themeDrift(username: string, level?: "scene" | "arc"): Promise<ThemeDriftBucket[]>;

  // ── analytics: LLM card analysis + tag auto-suggest (B.0 stretch) ──────────
  /** Rich LLM comparison of two cards — similarities/differences/redundancy/verdict. */
  compareCharactersDeep(
    username: string,
    characterIdA: string,
    characterIdB: string,
  ): Promise<DeepComparison | null>;
  /** Grammar-constrained Q&A over a card. */
  askCard(
    username: string,
    characterId: string,
    question: string,
  ): Promise<{ answer: string } | null>;
  /** Distilled tags not yet in the tags table — promotion candidates (review before applying). */
  tagSuggestions(username: string): Promise<TagSuggestion[]>;
  /** Promote approved distilled tags into the tags table (source='auto') + link characters. */
  applyTagSuggestions(username: string, tagNames: string[]): Promise<ApplyTagsResult>;
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

    computeCooccurrence(opts = {}) {
      return computeCooccurrence(db, opts);
    },

    async topKeywords(username, opts = {}) {
      const ownerId = await ensureUser(db, username);
      return topKeywords(db, ownerId, opts);
    },

    async cooccurringKeywords(username, keyword, limit) {
      const ownerId = await ensureUser(db, username);
      return cooccurringKeywords(db, ownerId, keyword, limit);
    },

    async characterKeywords(username, characterId, limit) {
      const ownerId = await ensureUser(db, username);
      return characterKeywords(db, ownerId, characterId, limit);
    },

    async themes(username, level = "scene") {
      const ownerId = await ensureUser(db, username);
      return themes(db, ownerId, level);
    },

    async similarityGraph(username, opts = {}) {
      const ownerId = await ensureUser(db, username);
      return characterSimilarityGraph(db, ownerId, opts);
    },

    async similarChats(username, chatId, limit) {
      const ownerId = await ensureUser(db, username);
      return similarChats(db, ownerId, chatId, limit);
    },

    computeCharacterSummaries() {
      return computeCharacterSummaries(db, { summarizer: createSummarizer() });
    },

    async browseCharacters(username, filter = {}) {
      const ownerId = await ensureUser(db, username);
      return browseCharacters(db, ownerId, filter);
    },

    async characterFacets(username) {
      const ownerId = await ensureUser(db, username);
      return characterFacets(db, ownerId);
    },

    async home(username) {
      const ownerId = await ensureUser(db, username);
      return homeView(db, ownerId);
    },

    async characterDossier(username, characterId) {
      const ownerId = await ensureUser(db, username);
      return characterDossier(db, ownerId, characterId);
    },

    async themeDetail(username, clusterIdx, level) {
      const ownerId = await ensureUser(db, username);
      return themeDetail(db, ownerId, clusterIdx, level);
    },

    async swipes(username) {
      const ownerId = await ensureUser(db, username);
      return swipeInsights(db, ownerId);
    },

    async catalog(username) {
      const ownerId = await ensureUser(db, username);
      return catalogStats(db, ownerId);
    },

    async compareCharacters(username, characterIdA, characterIdB) {
      const ownerId = await ensureUser(db, username);
      return compareCharacters(db, ownerId, characterIdA, characterIdB);
    },

    async archetypes(username, k) {
      const ownerId = await ensureUser(db, username);
      return characterArchetypes(db, ownerId, k);
    },

    async forgottenGems(username, limit) {
      const ownerId = await ensureUser(db, username);
      return forgottenGems(db, ownerId, limit);
    },

    async modelRouting(username) {
      const ownerId = await ensureUser(db, username);
      return modelRouting(db, ownerId);
    },

    async themeDrift(username, level) {
      const ownerId = await ensureUser(db, username);
      return themeDrift(db, ownerId, level);
    },

    async compareCharactersDeep(username, characterIdA, characterIdB) {
      const ownerId = await ensureUser(db, username);
      return compareCharactersDeep(db, ownerId, createSummarizer(), characterIdA, characterIdB);
    },

    async askCard(username, characterId, question) {
      const ownerId = await ensureUser(db, username);
      return askCard(db, ownerId, createSummarizer(), characterId, question);
    },

    async tagSuggestions(username) {
      const ownerId = await ensureUser(db, username);
      return tagSuggestions(db, ownerId);
    },

    async applyTagSuggestions(username, tagNames) {
      const ownerId = await ensureUser(db, username);
      return applyTagSuggestions(db, ownerId, tagNames);
    },
  };
}
