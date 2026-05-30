import { z } from "zod";
import { brandedId, type PersonaId } from "../../../shared/ids";
import { createPersonaSchema, updatePersonaSchema } from "../../domain/persona";
import { authedProcedure, t } from "../trpc";

const updateSchema = updatePersonaSchema.extend({ personaId: brandedId<PersonaId>() });

export const personaRouter = t.router({
  list: authedProcedure.query(({ ctx }) => ctx.services.persona.list({ username: ctx.username })),

  get: authedProcedure
    .input(z.object({ personaId: brandedId<PersonaId>() }))
    .query(({ ctx, input }) =>
      ctx.services.persona.get({ username: ctx.username }, input.personaId),
    ),

  create: authedProcedure
    .input(createPersonaSchema)
    .mutation(({ ctx, input }) => ctx.services.persona.create({ username: ctx.username }, input)),

  update: authedProcedure.input(updateSchema).mutation(({ ctx, input }) => {
    const { personaId, ...edits } = input;
    return ctx.services.persona.update({ username: ctx.username }, personaId, edits);
  }),

  remove: authedProcedure
    .input(z.object({ personaId: brandedId<PersonaId>() }))
    .mutation(({ ctx, input }) =>
      ctx.services.persona.remove({ username: ctx.username }, input.personaId),
    ),
});
