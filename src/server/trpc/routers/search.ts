import { z } from "zod";
import { publicProcedure, t } from "../trpc";

// Thin drivers over domain/search + domain/corpus. `corpus.embed` is a dev/seed entry
// (the importer drives the domain service directly); knn is global for now — owner
// scoping lands with the real corpus + multi-user.
export const searchRouter = t.router({
  knn: publicProcedure
    .input(
      z.object({
        queryText: z.string().min(1),
        k: z.number().int().positive().max(50).optional(),
        /** Second-stage cross-encoder rerank (4.6.3b) — better order, costs a model pass. */
        rerank: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => ctx.services.search.knn(input)),
});

export const corpusRouter = t.router({
  embed: publicProcedure
    .input(
      z.object({
        entityType: z.string().min(1),
        entityId: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.corpus.embedAndStore(input)),
});
