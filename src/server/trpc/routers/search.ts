import { z } from "zod";
import { authedProcedure, t } from "../trpc";

// ONE unified semantic search over the corpus. `over` picks the substrate, `group` shapes the result,
// `rerank` is the only scoring knob (CSLS hubness correction is always on — the locked default). The
// result is a discriminated union keyed by `over`/`group` the client switches on. Replaces the former
// knn/find/discover/digests/segments/corpus endpoints; the substrate/tier selector you'd otherwise need
// six endpoints for is now one parameter.
const searchInput = z.object({
  q: z.string().min(1),
  over: z.enum(["characters", "segments", "scenes", "arcs", "mix"]).default("mix"),
  /** 'character' groups segment hits by character (the "who have I done X with" view). */
  group: z.enum(["none", "character"]).default("none"),
  k: z.number().int().positive().max(50).optional(),
  /** Second-stage cross-encoder rerank — better order, costs a model pass. CSLS is always on. */
  rerank: z.boolean().optional(),
});

export const searchRouter = t.router({
  search: authedProcedure.input(searchInput).query(async ({ ctx, input }) => {
    const { q: queryText, over, group, k, rerank } = input;
    const s = ctx.services.search;
    const username = ctx.username;
    if (over === "characters") {
      return { over, group: "none" as const, hits: await s.find({ queryText, k, rerank }) };
    }
    if (over === "segments") {
      if (group === "character") {
        return { over, group, hits: await s.discover({ queryText, k, rerank }) };
      }
      return {
        over,
        group: "none" as const,
        hits: await s.segments({ queryText, username, k, rerank }),
      };
    }
    if (over === "scenes" || over === "arcs") {
      const tier = over === "scenes" ? "scene" : "arc";
      return {
        over,
        group: "none" as const,
        hits: await s.digests({ queryText, username, k, rerank, tier }),
      };
    }
    return {
      over,
      group: "none" as const,
      hits: await s.corpus({ queryText, username, k, rerank }),
    };
  }),

  // Cross-modal image search (SigLIP) — a different model/space, kept separate from the text search.
  images: authedProcedure
    .input(
      z.object({ queryText: z.string().min(1), k: z.number().int().positive().max(50).optional() }),
    )
    .query(({ ctx, input }) => ctx.services.search.images(input)),
});

export const corpusRouter = t.router({
  embed: authedProcedure
    .input(
      z.object({
        characterId: z.string().min(1),
        ownerId: z.string().min(1),
        characterVersionId: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.corpus.embedAndStore(input)),
});
