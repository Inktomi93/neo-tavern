import { z } from "zod";
import type { CreatePersonaInput, UpdatePersonaInput } from "../../domain/persona";
import { authedProcedure, t } from "../trpc";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(100000),
  avatarAssetId: z.string().nullable().optional(),
  metadata: z.any().optional(),
});
const updateSchema = createSchema.partial().extend({ personaId: z.string().min(1) });

export const personaRouter = t.router({
  list: authedProcedure.query(({ ctx }) => ctx.services.persona.list({ username: ctx.username })),

  get: authedProcedure
    .input(z.object({ personaId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.persona.get({ username: ctx.username }, input.personaId),
    ),

  create: authedProcedure
    .input(createSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.persona.create({ username: ctx.username }, input as CreatePersonaInput),
    ),

  update: authedProcedure.input(updateSchema).mutation(({ ctx, input }) => {
    const { personaId, ...edits } = input;
    return ctx.services.persona.update(
      { username: ctx.username },
      personaId,
      edits as UpdatePersonaInput,
    );
  }),

  remove: authedProcedure
    .input(z.object({ personaId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.persona.remove({ username: ctx.username }, input.personaId),
    ),
});
