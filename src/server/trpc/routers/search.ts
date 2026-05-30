import { z } from "zod";
import { authedProcedure, t } from "../trpc";

// Thin drivers over domain/search + domain/corpus. `corpus.embed` is a dev/seed entry
// (the importer drives the domain service directly); knn is global for now — owner
// scoping lands with the real corpus + multi-user.

// Shared input schema for all knn-style searches: query text + optional pool size + optional rerank.
// Adding a new search knob (e.g. filters) touches this once and flows to all procedures.
const knnInput = z.object({
  queryText: z.string().min(1),
  k: z.number().int().positive().max(50).optional(),
  /** Second-stage cross-encoder rerank (4.6.3b) — better order, costs a model pass. */
  rerank: z.boolean().optional(),
});

export const searchRouter = t.router({
  knn: authedProcedure.input(knnInput).query(({ ctx, input }) => ctx.services.search.knn(input)),

  // Display-ready semantic search (the "Find" UI mode): enriched cards + segment snippets.
  find: authedProcedure.input(knnInput).query(({ ctx, input }) => ctx.services.search.find(input)),

  // "Who have I actually done X with?" — searches chat segments, groups by character.
  discover: authedProcedure
    .input(knnInput)
    .query(({ ctx, input }) => ctx.services.search.discover(input)),

  // Cross-chat search over the within-chat memory DIGEST substrate (docs/subsystems/chat-memory.md §4): the same
  // structured digests, queried globally but SCOPED to the caller (chat_digests.ownerId). Hits carry
  // the canon seq span for verbatim click-through. User-facing search, NOT in-character memory.
  digests: authedProcedure
    .input(knnInput)
    .query(({ ctx, input }) => ctx.services.search.digests({ ...input, username: ctx.username })),

  // Verbatim half of the hybrid: cross-chat search over raw message segments (owner-scoped).
  segments: authedProcedure
    .input(knnInput)
    .query(({ ctx, input }) => ctx.services.search.segments({ ...input, username: ctx.username })),

  // The hybrid "mix": both lenses (digests = theme/precision, segments = verbatim) for one query.
  corpus: authedProcedure
    .input(knnInput)
    .query(({ ctx, input }) => ctx.services.search.corpus({ ...input, username: ctx.username })),

  // Cross-modal search: find images based on text query using SigLIP embeddings. No rerank knob
  // (cross-modal reranking is a different model — not the text reranker).
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
