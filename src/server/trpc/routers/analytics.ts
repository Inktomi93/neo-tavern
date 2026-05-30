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
});
