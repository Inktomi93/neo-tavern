import { z } from "zod";
import { brandedId, type PresetId } from "../../../shared/ids";
import { promptConfigSchema } from "../../../shared/prompt-config";
import { authedProcedure, t } from "../trpc";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.string().min(1).max(100),
  config: promptConfigSchema.optional(),
});

const updateSchema = createSchema.partial().extend({ presetId: brandedId<PresetId>() });

// Thin driver: validate input, call the domain service, translate domain errors. No db access.

export const presetRouter = t.router({
  // The caller's preset library, newest-updated first (owner-scoped).
  list: authedProcedure.query(({ ctx }) => ctx.services.preset.list({ username: ctx.username })),

  // One owned preset + its current config. NOT_FOUND if unowned.
  get: authedProcedure
    .input(z.object({ presetId: brandedId<PresetId>() }))
    .query(({ ctx, input }) => ctx.services.preset.get({ username: ctx.username, ...input })),

  create: authedProcedure
    .input(createSchema)
    .mutation(({ ctx, input }) => ctx.services.preset.create({ username: ctx.username, ...input })),

  // Copy-on-write: editing config forks a new version if the current one is pinned, else mutates
  // in place. name/kind edit the identity row directly. NOT_FOUND if unowned.
  update: authedProcedure
    .input(updateSchema)
    .mutation(({ ctx, input }) => ctx.services.preset.update({ username: ctx.username, ...input })),

  // Hard delete. BAD_REQUEST (preset_in_use) if a version is pinned by a chat/message.
  remove: authedProcedure
    .input(z.object({ presetId: brandedId<PresetId>() }))
    .mutation(({ ctx, input }) => ctx.services.preset.remove({ username: ctx.username, ...input })),
});
