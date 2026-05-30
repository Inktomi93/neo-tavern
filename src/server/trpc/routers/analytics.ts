import { z } from "zod";
import { authedProcedure, t } from "../trpc";

// Unified corpus-analytics surface (docs/planning/breadth-buildout.md Track B). Each endpoint maps to
// ONE front-end surface; the heavy precompute lives in scripts. Thin: validate → call the corpus
// service (owner-scoped via ctx.username). The granular building blocks are bundled into page views
// (home / character / theme) so the client makes one call per screen, not a dozen.

const LEVEL = z.enum(["scene", "arc"]);

export const analyticsRouter = t.router({
  // The corpus home — most-RP'd characters + activity timeline + top scene/arc themes + cleanup counts.
  home: authedProcedure.query(({ ctx }) => ctx.services.corpus.home(ctx.username)),

  // A character page — profile + distillation + keywords + scene/arc theme profile + similar characters.
  character: authedProcedure
    .input(z.object({ characterId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.corpus.characterDossier(ctx.username, input.characterId),
    ),

  // The filterable character CATALOG — narrow 300+ characters by distilled genre/tone/tag + free text.
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

  // Distinct genres/tones present — populates the catalog filter dropdowns.
  characterFacets: authedProcedure.query(({ ctx }) =>
    ctx.services.corpus.characterFacets(ctx.username),
  ),

  // Themes at an altitude — 'scene' (recurring moments) or 'arc' (overarching narrative shapes).
  themes: authedProcedure
    .input(z.object({ level: LEVEL.optional() }).optional())
    .query(({ ctx, input }) => ctx.services.corpus.themes(ctx.username, input?.level)),

  // One theme's detail — facets + story-time timeline + the characters most present in it.
  theme: authedProcedure
    .input(z.object({ clusterIdx: z.number().int().nonnegative(), level: LEVEL.optional() }))
    .query(({ ctx, input }) =>
      ctx.services.corpus.themeDetail(ctx.username, input.clusterIdx, input.level ?? "scene"),
    ),

  // Near-duplicates — `type` selects characters | chats (chats label fork lineage). One endpoint;
  // the result is a discriminated union the client switches on by `type`.
  duplicates: authedProcedure
    .input(
      z.object({
        type: z.enum(["characters", "chats"]),
        threshold: z.number().min(0).max(1).optional(),
        includeForked: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.type === "characters") {
        const pairs = await ctx.services.corpus.duplicateCharacters(ctx.username, {
          threshold: input.threshold,
        });
        return { type: "characters" as const, pairs };
      }
      const pairs = await ctx.services.corpus.duplicateChats(ctx.username, {
        threshold: input.threshold,
        includeForked: input.includeForked,
      });
      return { type: "chats" as const, pairs };
    }),

  // Keyword explorer — characterId → that character's keywords; seed → co-occurring; neither → top.
  keywords: authedProcedure
    .input(
      z
        .object({
          characterId: z.string().optional(),
          seed: z.string().optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .optional()
        .transform((v) => v ?? {}),
    )
    .query(({ ctx, input }) => {
      if (input.characterId) {
        return ctx.services.corpus.characterKeywords(ctx.username, input.characterId, input.limit);
      }
      if (input.seed) {
        return ctx.services.corpus.cooccurringKeywords(ctx.username, input.seed, input.limit);
      }
      return ctx.services.corpus.topKeywords(ctx.username, { limit: input.limit });
    }),

  // Character similarity graph (force-directed view).
  graph: authedProcedure
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

  // Swipe/re-roll insights — most re-rolled moments + which characters/models make you re-roll.
  swipes: authedProcedure.query(({ ctx }) => ctx.services.corpus.swipes(ctx.username)),

  // Distill-powered catalog — collected-vs-played by genre/tone, top tags, tag co-occurrence.
  catalog: authedProcedure.query(({ ctx }) => ctx.services.corpus.catalog(ctx.username)),

  // Compare two characters by distilled facets (no-LLM compare_cards; pairs with duplicates).
  compareCharacters: authedProcedure
    .input(z.object({ a: z.string().min(1), b: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.corpus.compareCharacters(ctx.username, input.a, input.b),
    ),

  // Character archetypes — cluster card embeddings, labeled by dominant distilled facets.
  archetypes: authedProcedure
    .input(
      z
        .object({ k: z.number().int().positive().max(40).optional() })
        .optional()
        .transform((v) => v ?? {}),
    )
    .query(({ ctx, input }) => ctx.services.corpus.archetypes(ctx.username, input.k)),

  // Forgotten gems — characters you invested in but haven't touched recently (revisit candidates).
  forgottenGems: authedProcedure
    .input(
      z
        .object({ limit: z.number().int().positive().max(100).optional() })
        .optional()
        .transform((v) => v ?? {}),
    )
    .query(({ ctx, input }) => ctx.services.corpus.forgottenGems(ctx.username, input.limit)),

  // Which model you reach for per genre.
  modelRouting: authedProcedure.query(({ ctx }) => ctx.services.corpus.modelRouting(ctx.username)),

  // How your themes shift over story time (drift).
  themeDrift: authedProcedure
    .input(z.object({ level: LEVEL.optional() }).optional())
    .query(({ ctx, input }) => ctx.services.corpus.themeDrift(ctx.username, input?.level)),

  // Rich LLM comparison of two cards — similarities/differences/redundancy/verdict (1 LLM call).
  compareCharactersDeep: authedProcedure
    .input(z.object({ a: z.string().min(1), b: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.corpus.compareCharactersDeep(ctx.username, input.a, input.b),
    ),

  // Grammar-constrained Q&A over a card.
  askCard: authedProcedure
    .input(z.object({ characterId: z.string().min(1), question: z.string().min(1).max(500) }))
    .query(({ ctx, input }) =>
      ctx.services.corpus.askCard(ctx.username, input.characterId, input.question),
    ),

  // Distilled tags not yet in the tags table, with their full candidate character list — for review.
  tagSuggestions: authedProcedure
    .input(
      z
        .object({ minCount: z.number().int().positive().optional() })
        .optional()
        .transform((v) => v ?? {}),
    )
    .query(({ ctx, input }) => ctx.services.corpus.tagSuggestions(ctx.username, input.minCount)),

  // Apply the REVIEWED assignments — pick which tags, and within each, which characters. Mutation.
  applyTagSuggestions: authedProcedure
    .input(
      z.object({
        assignments: z
          .array(
            z.object({
              tag: z.string().min(2),
              characterIds: z.array(z.string().min(1)).min(1),
            }),
          )
          .min(1)
          .max(300),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.corpus.applyTagSuggestions(ctx.username, input.assignments),
    ),

  // The current auto-applied tags + link counts (the review screen's "already applied" state).
  appliedAutoTags: authedProcedure.query(({ ctx }) =>
    ctx.services.corpus.appliedAutoTags(ctx.username),
  ),

  // Undo an auto-applied tag entirely (tag + its character links). Mutation.
  removeAutoTag: authedProcedure
    .input(z.object({ tag: z.string().min(1) }))
    .mutation(({ ctx, input }) => ctx.services.corpus.removeAutoTag(ctx.username, input.tag)),

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
});
