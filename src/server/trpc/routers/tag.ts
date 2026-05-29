import { z } from "zod";
import { authedProcedure, t } from "../trpc";

// Shared input for tag attachment mutations — attach and detach take the same three fields.
const tagTargetInput = z.object({
  tagId: z.string().min(1),
  targetType: z.enum(["character", "chat", "worldBook", "persona", "preset"]),
  targetId: z.string().min(1),
});

export const tagRouter = t.router({
  list: authedProcedure.query(({ ctx }) => ctx.services.tag.listTags({ username: ctx.username })),

  get: authedProcedure
    .input(z.object({ tagId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.services.tag.getTag({ username: ctx.username }, input.tagId)),

  create: authedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        color: z.string().optional(),
        source: z.enum(["manual", "auto"]).optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.tag.createTag({ username: ctx.username }, input)),

  update: authedProcedure
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
      return ctx.services.tag.updateTag({ username: ctx.username }, tagId, edits);
    }),

  remove: authedProcedure
    .input(z.object({ tagId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.tag.removeTag({ username: ctx.username }, input.tagId),
    ),

  attach: authedProcedure.input(tagTargetInput).mutation(async ({ ctx, input }) => {
    await ctx.services.tag.attachTag(
      { username: ctx.username },
      input.tagId,
      input.targetType,
      input.targetId,
    );
    return { success: true };
  }),

  detach: authedProcedure.input(tagTargetInput).mutation(async ({ ctx, input }) => {
    await ctx.services.tag.detachTag(
      { username: ctx.username },
      input.tagId,
      input.targetType,
      input.targetId,
    );
    return { success: true };
  }),
});
