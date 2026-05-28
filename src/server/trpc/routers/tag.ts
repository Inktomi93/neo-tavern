import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { TagNotFoundError } from "../../domain/tag";
import { publicProcedure, t } from "../trpc";

function domainErrorToTrpc(error: unknown): never {
  if (error instanceof TagNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  throw error;
}

export const tagRouter = t.router({
  list: publicProcedure.query(({ ctx }) => ctx.services.tag.listTags({ username: ctx.username })),

  get: publicProcedure
    .input(z.object({ tagId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.tag.getTag({ username: ctx.username }, input.tagId).catch(domainErrorToTrpc),
    ),

  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        color: z.string().optional(),
        source: z.enum(["manual", "auto"]).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.tag.createTag({ username: ctx.username }, input).catch(domainErrorToTrpc),
    ),

  update: publicProcedure
    .input(
      z.object({
        tagId: z.string().min(1),
        name: z.string().min(1).max(200).optional(),
        color: z.string().optional(),
        source: z.enum(["manual", "auto"]).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { tagId, ...edits } = input;
      return ctx.services.tag
        .updateTag({ username: ctx.username }, tagId, edits)
        .catch(domainErrorToTrpc);
    }),

  remove: publicProcedure
    .input(z.object({ tagId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.tag.removeTag({ username: ctx.username }, input.tagId).catch(domainErrorToTrpc),
    ),

  attach: publicProcedure
    .input(
      z.object({
        tagId: z.string().min(1),
        targetType: z.enum(["character", "chat", "worldBook", "persona", "preset"]),
        targetId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.services.tag
        .attachTag({ username: ctx.username }, input.tagId, input.targetType, input.targetId)
        .catch(domainErrorToTrpc);
      return { success: true };
    }),

  detach: publicProcedure
    .input(
      z.object({
        tagId: z.string().min(1),
        targetType: z.enum(["character", "chat", "worldBook", "persona", "preset"]),
        targetId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.services.tag
        .detachTag({ username: ctx.username }, input.tagId, input.targetType, input.targetId)
        .catch(domainErrorToTrpc);
      return { success: true };
    }),
});
