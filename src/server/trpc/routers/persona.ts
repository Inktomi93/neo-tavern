import { z } from "zod";
import type { CreatePersonaInput, UpdatePersonaInput } from "../../domain/persona";
import { publicProcedure, t } from "../trpc";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(100000),
  avatarAssetId: z.string().nullable().optional(),
  metadata: z.any().optional(),
});
const updateSchema = createSchema.partial().extend({ personaId: z.string().min(1) });

export const personaRouter = t.router({
  list: publicProcedure.query(({ ctx }) => ctx.services.persona.list({ username: ctx.username })),

  get: publicProcedure
    .input(z.object({ personaId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.persona.get({ username: ctx.username }, input.personaId),
    ),

  create: publicProcedure
    .input(createSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.persona.create({ username: ctx.username }, input as CreatePersonaInput),
    ),

  update: publicProcedure.input(updateSchema).mutation(({ ctx, input }) => {
    const { personaId, ...edits } = input;
    return ctx.services.persona.update(
      { username: ctx.username },
      personaId,
      edits as UpdatePersonaInput,
    );
  }),

  remove: publicProcedure
    .input(z.object({ personaId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.persona.remove({ username: ctx.username }, input.personaId),
    ),
});
