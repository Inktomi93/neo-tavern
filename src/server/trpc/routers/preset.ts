import { z } from "zod";
import { promptConfigSchema } from "../../../shared/prompt-config";
import { publicProcedure, t } from "../trpc";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.string().min(1).max(100),
  config: promptConfigSchema.optional(),
});

const updateSchema = createSchema.partial().extend({ presetId: z.string().min(1) });

// Thin driver: validate input, call the domain service, translate domain errors. No db access.

export const presetRouter = t.router({
  // The caller's preset library, newest-updated first (owner-scoped).
  list: publicProcedure.query(({ ctx }) => ctx.services.preset.list({ username: ctx.username })),

  // One owned preset + its current config. NOT_FOUND if unowned.
  get: publicProcedure
    .input(z.object({ presetId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.services.preset.get({ username: ctx.username, ...input })),

  create: publicProcedure
    .input(createSchema)
    .mutation(({ ctx, input }) => ctx.services.preset.create({ username: ctx.username, ...input })),

  // Copy-on-write: editing config forks a new version if the current one is pinned, else mutates
  // in place. name/kind edit the identity row directly. NOT_FOUND if unowned.
  update: publicProcedure
    .input(updateSchema)
    .mutation(({ ctx, input }) => ctx.services.preset.update({ username: ctx.username, ...input })),

  // Hard delete. BAD_REQUEST (preset_in_use) if a version is pinned by a chat/message.
  remove: publicProcedure
    .input(z.object({ presetId: z.string().min(1) }))
    .mutation(({ ctx, input }) => ctx.services.preset.remove({ username: ctx.username, ...input })),
});
