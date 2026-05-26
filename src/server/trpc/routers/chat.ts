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
    // fork-to-sdk is a real not-yet-built capability; the others are bad requests for the state.
    const code = error.reason === "fork_sdk_unsupported" ? "NOT_IMPLEMENTED" : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
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

  // Branch a chat at a seq into a new chat. targetMode 'sdk' → NOT_IMPLEMENTED (seeding deferred).
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
});
