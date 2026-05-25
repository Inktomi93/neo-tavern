import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ChatNotFoundError } from "../../domain/chat";
import { publicProcedure, t } from "../trpc";

// Thin driver: validate input, call the domain service via ctx, translate the one
// domain error to a transport error. No db/provider access here.
function notFoundToTrpc(error: unknown): never {
  if (error instanceof ChatNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
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
        .catch(notFoundToTrpc),
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
      ctx.services.chat.send({ username: ctx.username, ...input }).catch(notFoundToTrpc),
    ),
});
