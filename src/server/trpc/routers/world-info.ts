import { z } from "zod";
import { authedProcedure, t } from "../trpc";

export const worldInfoRouter = t.router({
  listBooks: authedProcedure.query(({ ctx }) =>
    ctx.services.worldInfo.listBooks({ username: ctx.username }),
  ),

  getBook: authedProcedure
    .input(z.object({ bookId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.worldInfo.getBook({ username: ctx.username }, input.bookId),
    ),

  createBook: authedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.worldInfo.createBook({ username: ctx.username }, input),
    ),

  updateBook: authedProcedure
    .input(
      z.object({
        bookId: z.string().min(1),
        name: z.string().min(1).max(200).optional(),
        description: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { bookId, ...edits } = input;
      return ctx.services.worldInfo.updateBook({ username: ctx.username }, bookId, edits);
    }),

  removeBook: authedProcedure
    .input(z.object({ bookId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.worldInfo.removeBook({ username: ctx.username }, input.bookId),
    ),

  listEntries: authedProcedure
    .input(z.object({ bookId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.worldInfo.listEntries({ username: ctx.username }, input.bookId),
    ),

  getEntry: authedProcedure
    .input(z.object({ entryId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.worldInfo.getEntry({ username: ctx.username }, input.entryId),
    ),

  createEntry: authedProcedure
    .input(
      z.object({
        bookId: z.string().min(1),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(100000),
        legacyKeys: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
        priority: z.number().int().optional(),
        metadata: z.any().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { bookId, ...entryInput } = input;
      return ctx.services.worldInfo.createEntry({ username: ctx.username }, bookId, entryInput);
    }),

  updateEntry: authedProcedure
    .input(
      z.object({
        entryId: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        content: z.string().min(1).max(100000).optional(),
        legacyKeys: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
        priority: z.number().int().optional(),
        metadata: z.any().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { entryId, ...edits } = input;
      return ctx.services.worldInfo.updateEntry({ username: ctx.username }, entryId, edits);
    }),

  removeEntry: authedProcedure
    .input(z.object({ entryId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.worldInfo.removeEntry({ username: ctx.username }, input.entryId),
    ),
});
