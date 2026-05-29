import { z } from "zod";
import type { CreateCharacterInput, UpdateCharacterInput } from "../../domain/character";
import { publicProcedure, t } from "../trpc";

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
  characterId: z.string().min(1),
  starred: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const characterRouter = t.router({
  list: publicProcedure.query(({ ctx }) => ctx.services.character.list({ username: ctx.username })),

  get: publicProcedure
    .input(z.object({ characterId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.character.get({ username: ctx.username }, input.characterId),
    ),

  create: publicProcedure
    .input(createSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.character.create({ username: ctx.username }, input as CreateCharacterInput),
    ),

  update: publicProcedure.input(updateSchema).mutation(({ ctx, input }) => {
    const { characterId, ...edits } = input;
    return ctx.services.character.update(
      { username: ctx.username },
      characterId,
      edits as UpdateCharacterInput,
    );
  }),

  remove: publicProcedure
    .input(z.object({ characterId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.character.remove({ username: ctx.username }, input.characterId),
    ),
});
