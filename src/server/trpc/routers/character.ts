import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  CharacterNotFoundError,
  CharacterOperationError,
  type CreateCharacterInput,
  type UpdateCharacterInput,
} from "../../domain/character";
import { publicProcedure, t } from "../trpc";

function domainErrorToTrpc(error: unknown): never {
  if (error instanceof CharacterNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (error instanceof CharacterOperationError) {
    if (error.code === "handle_conflict") {
      throw new TRPCError({ code: "CONFLICT", message: error.message });
    }
    if (error.code === "character_in_use") {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw error;
}

export const characterRouter = t.router({
  list: publicProcedure.query(({ ctx }) => ctx.services.character.list({ username: ctx.username })),

  get: publicProcedure
    .input(z.object({ characterId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.character
        .get({ username: ctx.username }, input.characterId)
        .catch(domainErrorToTrpc),
    ),

  create: publicProcedure
    .input(
      z.object({
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
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.character
        .create({ username: ctx.username }, input as CreateCharacterInput)
        .catch(domainErrorToTrpc),
    ),

  update: publicProcedure
    .input(
      z.object({
        characterId: z.string().min(1),
        handle: z.string().min(1).max(200).optional(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(100000).optional(),
        personality: z.string().nullable().optional(),
        scenario: z.string().nullable().optional(),
        greetings: z.array(z.string()).nullable().optional(),
        exampleMessages: z.string().nullable().optional(),
        systemPrompt: z.string().nullable().optional(),
        postHistoryInstructions: z.string().nullable().optional(),
        tags: z.array(z.string()).nullable().optional(),
        creatorNotes: z.string().nullable().optional(),
        avatarAssetId: z.string().nullable().optional(),
        starred: z.boolean().optional(),
        archived: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { characterId, ...edits } = input;
      return ctx.services.character
        .update({ username: ctx.username }, characterId, edits as UpdateCharacterInput)
        .catch(domainErrorToTrpc);
    }),

  remove: publicProcedure
    .input(z.object({ characterId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.character
        .remove({ username: ctx.username }, input.characterId)
        .catch(domainErrorToTrpc),
    ),
});
