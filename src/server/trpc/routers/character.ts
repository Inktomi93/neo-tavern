import { z } from "zod";
import { brandedId, type CharacterId } from "../../../shared/ids";
import type { CreateCharacterInput, UpdateCharacterInput } from "../../domain/character";
import { authedProcedure, t } from "../trpc";

const createSchema = z.object({
  handle: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(100000),
  personality: z.string().nullable().optional(),
  scenario: z.string().nullable().optional(),
  greetings: z.array(z.string()).nullable().optional(),
  exampleMessages: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  postHistoryInstructions: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  creatorNotes: z.string().nullable().optional(),
  avatarAssetId: z.string().nullable().optional(),
});

const updateSchema = createSchema.partial().extend({
  characterId: brandedId<CharacterId>(),
  starred: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const characterRouter = t.router({
  list: authedProcedure.query(({ ctx }) => ctx.services.character.list({ username: ctx.username })),

  get: authedProcedure
    .input(z.object({ characterId: brandedId<CharacterId>() }))
    .query(({ ctx, input }) =>
      ctx.services.character.get({ username: ctx.username }, input.characterId),
    ),

  create: authedProcedure
    .input(createSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.character.create({ username: ctx.username }, input as CreateCharacterInput),
    ),

  update: authedProcedure.input(updateSchema).mutation(({ ctx, input }) => {
    const { characterId, ...edits } = input;
    return ctx.services.character.update(
      { username: ctx.username },
      characterId,
      edits as UpdateCharacterInput,
    );
  }),

  remove: authedProcedure
    .input(z.object({ characterId: brandedId<CharacterId>() }))
    .mutation(({ ctx, input }) =>
      ctx.services.character.remove({ username: ctx.username }, input.characterId),
    ),
});
