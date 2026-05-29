import { on } from "node:events";
import { z } from "zod";
import { chatStreamEmitter } from "../../domain/chat";
import { publicProcedure, t } from "../trpc";

// Thin driver: validate input, call the domain service via ctx, translate domain errors to
// transport errors. No db/provider access here.

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

  // The caller's chats, newest-updated first (owner-scoped) — the chat-list rail.
  list: publicProcedure.query(({ ctx }) => ctx.services.chat.listChats({ username: ctx.username })),

  // One owned chat's metadata (summary + pins/links). NOT_FOUND if unowned.
  get: publicProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.chat.getChat({ username: ctx.username, chatId: input.chatId }),
    ),

  messages: publicProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.chat.listMessages({ username: ctx.username, chatId: input.chatId }),
    ),

  // Dry-run: the system prompt + routing the NEXT turn would use, WITHOUT generating. The
  // "what will this send / why did this world-info fire" inspector. NOT_FOUND if unowned.
  previewAssembly: publicProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.chat.previewAssembly({ username: ctx.username, chatId: input.chatId }),
    ),

  send: publicProcedure
    .input(
      z.object({
        chatId: z.string().min(1),
        expectedSeq: z.number().int().nonnegative(),
        content: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.chat.send({ username: ctx.username, ...input })),

  // Subscribe to real-time token deltas for a specific chat.
  streamMessages: publicProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .subscription(async function* ({ input, signal }) {
      try {
        for await (const [event] of on(chatStreamEmitter, "delta", { signal })) {
          if (event.chatId === input.chatId) {
            yield event.text as string;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") throw err;
      }
    }),

  // Switch a chat's api/source/model in place (the generalized escape valve). NOT_FOUND if unowned,
  // BAD_REQUEST on an incoherent/unimplemented combo.
  setProvider: publicProcedure
    .input(
      z.object({
        chatId: z.string().min(1),
        api: z.enum(["agent-sdk", "chat-completions", "responses"]),
        source: z.enum(["max-pro-sub", "openrouter"]),
        model: z.string().min(1).nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.chat.setProvider({ username: ctx.username, ...input }),
    ),

  // Branch a chat at a seq into a new chat (optionally switching api/source at the branch point).
  fork: publicProcedure
    .input(
      z.object({
        chatId: z.string().min(1),
        atSeq: z.number().int().positive(),
        targetApi: z.enum(["agent-sdk", "chat-completions", "responses"]),
        targetSource: z.enum(["max-pro-sub", "openrouter"]),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.chat.forkChat({ username: ctx.username, ...input })),

  // Swipe: regenerate the last assistant turn as a new variant (same result shape as send).
  swipe: publicProcedure
    .input(z.object({ chatId: z.string().min(1), expectedSeq: z.number().int().nonnegative() }))
    .mutation(({ ctx, input }) => ctx.services.chat.swipe({ username: ctx.username, ...input })),

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
      ctx.services.chat.selectVariant({ username: ctx.username, ...input }),
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
      ctx.services.chat.editMessage({ username: ctx.username, ...input }),
    ),

  // Manually compact an agent-sdk chat's session (steered /compact). { compacted: false } if the
  // chat can't be compacted (openrouter, or no session yet).
  compact: publicProcedure
    .input(z.object({ chatId: z.string().min(1), instructions: z.string().min(1).optional() }))
    .mutation(({ ctx, input }) => ctx.services.chat.compact({ username: ctx.username, ...input })),

  delete: publicProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .mutation(({ ctx, input }) => ctx.services.chat.delete({ username: ctx.username, ...input })),

  updateTitle: publicProcedure
    .input(z.object({ chatId: z.string().min(1), title: z.string().min(1).max(200) }))
    .mutation(({ ctx, input }) =>
      ctx.services.chat.updateTitle({ username: ctx.username, ...input }),
    ),

  star: publicProcedure
    .input(z.object({ chatId: z.string().min(1), starred: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.services.chat.star({ username: ctx.username, ...input })),

  archive: publicProcedure
    .input(z.object({ chatId: z.string().min(1), archived: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.services.chat.archive({ username: ctx.username, ...input })),
});
