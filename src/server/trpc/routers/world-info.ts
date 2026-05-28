import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { WorldInfoNotFoundError } from "../../domain/world-info";
import { publicProcedure, t } from "../trpc";

function domainErrorToTrpc(error: unknown): never {
  if (error instanceof WorldInfoNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  throw error;
}

export const worldInfoRouter = t.router({
  listBooks: publicProcedure.query(({ ctx }) =>
    ctx.services.worldInfo.listBooks({ username: ctx.username }),
  ),

  getBook: publicProcedure
    .input(z.object({ bookId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.worldInfo
        .getBook({ username: ctx.username }, input.bookId)
        .catch(domainErrorToTrpc),
    ),

  createBook: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.worldInfo.createBook({ username: ctx.username }, input).catch(domainErrorToTrpc),
    ),

  updateBook: publicProcedure
    .input(
      z.object({
        bookId: z.string().min(1),
        name: z.string().min(1).max(200).optional(),
        description: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { bookId, ...edits } = input;
      return ctx.services.worldInfo
        .updateBook({ username: ctx.username }, bookId, edits)
        .catch(domainErrorToTrpc);
    }),

  removeBook: publicProcedure
    .input(z.object({ bookId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.worldInfo
        .removeBook({ username: ctx.username }, input.bookId)
        .catch(domainErrorToTrpc),
    ),

  listEntries: publicProcedure
    .input(z.object({ bookId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.worldInfo
        .listEntries({ username: ctx.username }, input.bookId)
        .catch(domainErrorToTrpc),
    ),

  getEntry: publicProcedure
    .input(z.object({ entryId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.worldInfo
        .getEntry({ username: ctx.username }, input.entryId)
        .catch(domainErrorToTrpc),
    ),

  createEntry: publicProcedure
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
      return ctx.services.worldInfo
        .createEntry({ username: ctx.username }, bookId, entryInput)
        .catch(domainErrorToTrpc);
    }),

  updateEntry: publicProcedure
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
      return ctx.services.worldInfo
        .updateEntry({ username: ctx.username }, entryId, edits)
        .catch(domainErrorToTrpc);
    }),

  removeEntry: publicProcedure
    .input(z.object({ entryId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.worldInfo
        .removeEntry({ username: ctx.username }, input.entryId)
        .catch(domainErrorToTrpc),
    ),
});
