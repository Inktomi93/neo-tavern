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

  // Display-ready semantic search (the "Find" UI mode): enriched cards + segment snippets.
  find: publicProcedure
    .input(
      z.object({
        queryText: z.string().min(1),
        k: z.number().int().positive().max(50).optional(),
        rerank: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => ctx.services.search.find(input)),

  // "Who have I actually done X with?" — searches chat segments, groups by character.
  discover: publicProcedure
    .input(
      z.object({
        queryText: z.string().min(1),
        k: z.number().int().positive().max(50).optional(),
        rerank: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => ctx.services.search.discover(input)),

  // Cross-chat search over the within-chat memory DIGEST substrate (docs/memory.md §4): the same
  // structured digests, queried globally but SCOPED to the caller (chat_digests.ownerId). Hits carry
  // the canon seq span for verbatim click-through. User-facing search, NOT in-character memory.
  digests: publicProcedure
    .input(
      z.object({
        queryText: z.string().min(1),
        k: z.number().int().positive().max(50).optional(),
        rerank: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => ctx.services.search.digests({ ...input, username: ctx.username })),
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
