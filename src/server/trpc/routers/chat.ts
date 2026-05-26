import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ChatNotFoundError, ChatOperationError } from "../../domain/chat";
import { publicProcedure, t } from "../trpc";

// Thin driver: validate input, call the domain service via ctx, translate domain errors to
// transport errors. No db/provider access here.
function domainErrorToTrpc(error: unknown): never {
  if (error instanceof ChatNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (error instanceof ChatOperationError) {
    // All current reasons (not_sdk, invalid_fork_point) are bad requests for the chat's state.
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw error;
}

export const chatRouter = t.router({
  create: publicProcedure
    .input(
      z.object({
        title: z.string().min(1).max(200),
        characterName: z.string().min(1).max(200),
        characterDescription: z.string().min(1),
        firstMessage: z.string().optional(),
        // Toggle: when no firstMessage, have the model write the opening (vs the user speaking first).
        generateOpeningIfEmpty: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.chat.create({ username: ctx.username, ...input })),

  messages: publicProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.chat
        .listMessages({ username: ctx.username, chatId: input.chatId })
        .catch(domainErrorToTrpc),
    ),

  send: publicProcedure
    .input(
      z.object({
        chatId: z.string().min(1),
        expectedSeq: z.number().int().nonnegative(),
        content: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.chat.send({ username: ctx.username, ...input }).catch(domainErrorToTrpc),
    ),

  // One-way sdk→raw conversion (the escape valve). NOT_FOUND if unowned, BAD_REQUEST if not sdk.
  convertToRaw: publicProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.chat
        .convertToRaw({ username: ctx.username, chatId: input.chatId })
        .catch(domainErrorToTrpc),
    ),

  // Branch a chat at a seq into a new chat.
  fork: publicProcedure
    .input(
      z.object({
        chatId: z.string().min(1),
        atSeq: z.number().int().positive(),
        targetMode: z.enum(["sdk", "raw"]),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.chat.forkChat({ username: ctx.username, ...input }).catch(domainErrorToTrpc),
    ),

  // Swipe: regenerate the last assistant turn as a new variant (same result shape as send).
  swipe: publicProcedure
    .input(z.object({ chatId: z.string().min(1), expectedSeq: z.number().int().nonnegative() }))
    .mutation(({ ctx, input }) =>
      ctx.services.chat.swipe({ username: ctx.username, ...input }).catch(domainErrorToTrpc),
    ),

  // Make an existing variant active (swipe ← →).
  selectVariant: publicProcedure
    .input(
      z.object({
        chatId: z.string().min(1),
        messageId: z.string().min(1),
        variantIdx: z.number().int().nonnegative(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.chat
        .selectVariant({ username: ctx.username, ...input })
        .catch(domainErrorToTrpc),
    ),

  // Edit a message in place.
  editMessage: publicProcedure
    .input(
      z.object({
        chatId: z.string().min(1),
        messageId: z.string().min(1),
        content: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.chat.editMessage({ username: ctx.username, ...input }).catch(domainErrorToTrpc),
    ),
});
