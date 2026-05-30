import { z } from "zod";
import { authedProcedure, t } from "../trpc";

// Corpus-analytics surface (docs/planning/breadth-buildout.md Track B). Thin: validate → call the
// corpus service, which reads the precomputed `duplicate_pairs` rollup (the heavy all-pairs matmul runs
// in scripts/find-duplicates.ts, not on a request). Owner-scoped via ctx.username.

const thresholdInput = z
  .object({ threshold: z.number().min(0).max(1).optional() })
  .optional()
  .transform((v) => v ?? {});

export const analyticsRouter = t.router({
  // Near-duplicate CHARACTERS — ranked by CSLS (hub artifacts sink). The "you imported this card twice"
  // / "these two are basically the same" view.
  duplicateCharacters: authedProcedure
    .input(thresholdInput)
    .query(({ ctx, input }) => ctx.services.corpus.duplicateCharacters(ctx.username, input)),

  // Near-duplicate CHATS — `forked` pairs are a known lineage (B.5.1), surfaced distinctly from genuine
  // independent look-alikes. `includeForked: false` hides fork families.
  duplicateChats: authedProcedure
    .input(
      z
        .object({
          threshold: z.number().min(0).max(1).optional(),
          includeForked: z.boolean().optional(),
        })
        .optional()
        .transform((v) => v ?? {}),
    )
    .query(({ ctx, input }) => ctx.services.corpus.duplicateChats(ctx.username, input)),

  // "More like this" for one character — live ANN kNN (port of card-curator `similar_cards`).
  similarCharacters: authedProcedure
    .input(
      z.object({
        characterId: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.services.corpus.similarCharacters(ctx.username, input.characterId, input.limit),
    ),

  // Corpus dashboard — totals, per-model usage, most-RP'd characters, activity timeline.
  corpusStats: authedProcedure.query(({ ctx }) => ctx.services.corpus.corpusStats(ctx.username)),

  // One character's full aggregate profile + top keywords.
  characterProfile: authedProcedure
    .input(z.object({ characterId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.corpus.characterProfile(ctx.username, input.characterId),
    ),

  // Pillar A — keyword co-occurrence. Most-frequent scene keywords across the corpus.
  topKeywords: authedProcedure
    .input(
      z
        .object({
          limit: z.number().int().positive().max(200).optional(),
          minCount: z.number().int().positive().optional(),
        })
        .optional()
        .transform((v) => v ?? {}),
    )
    .query(({ ctx, input }) => ctx.services.corpus.topKeywords(ctx.username, input)),

  // Keywords that co-occur with a given keyword in a scene (the "what goes with X" view).
  cooccurringKeywords: authedProcedure
    .input(
      z.object({
        keyword: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.services.corpus.cooccurringKeywords(ctx.username, input.keyword, input.limit),
    ),

  // Top scene keywords for one character.
  characterKeywords: authedProcedure
    .input(
      z.object({
        characterId: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.services.corpus.characterKeywords(ctx.username, input.characterId, input.limit),
    ),

  // Pillar B — emergent themes (k-means clusters, LLM-named).
  themes: authedProcedure.query(({ ctx }) => ctx.services.corpus.themes(ctx.username)),

  // A theme's activity over STORY time (msgMidAt-bucketed).
  themeTimeline: authedProcedure
    .input(
      z.object({
        clusterIdx: z.number().int().nonnegative(),
        bucketDays: z.number().int().positive().max(365).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.services.corpus.themeTimeline(ctx.username, input.clusterIdx, input.bucketDays),
    ),

  // Which themes a character's chats touch.
  characterThemeProfile: authedProcedure
    .input(z.object({ characterId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.corpus.characterThemeProfile(ctx.username, input.characterId),
    ),

  // The characters most present in a theme.
  themeCharacters: authedProcedure
    .input(
      z.object({
        clusterIdx: z.number().int().nonnegative(),
        limit: z.number().int().positive().max(100).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.services.corpus.themeCharacters(ctx.username, input.clusterIdx, input.limit),
    ),

  // Character similarity graph (force-directed view).
  similarityGraph: authedProcedure
    .input(
      z
        .object({
          minSimilarity: z.number().min(0).max(1).optional(),
          maxNodes: z.number().int().positive().max(500).optional(),
        })
        .optional()
        .transform((v) => v ?? {}),
    )
    .query(({ ctx, input }) => ctx.services.corpus.similarityGraph(ctx.username, input)),

  // "More like this chat" — nearest chats by segment-centroid cosine.
  similarChats: authedProcedure
    .input(
      z.object({
        chatId: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.services.corpus.similarChats(ctx.username, input.chatId, input.limit),
    ),

  // The filterable character catalog (distillation facets + engagement) — narrow 300+ chars at a glance.
  characters: authedProcedure
    .input(
      z
        .object({
          genre: z.string().optional(),
          tone: z.string().optional(),
          tag: z.string().optional(),
          q: z.string().optional(),
          sort: z.enum(["chats", "recent", "name"]).optional(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .optional()
        .transform((v) => v ?? {}),
    )
    .query(({ ctx, input }) => ctx.services.corpus.browseCharacters(ctx.username, input)),

  // One character's distilled facets (genre/tone/tags + elevator pitch + overview).
  characterSummary: authedProcedure
    .input(z.object({ characterId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.corpus.characterSummary(ctx.username, input.characterId),
    ),

  // Distinct genres/tones present — populates the browse filter dropdowns.
  characterFacets: authedProcedure.query(({ ctx }) =>
    ctx.services.corpus.characterFacets(ctx.username),
  ),
});
