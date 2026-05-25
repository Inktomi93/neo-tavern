import { z } from "zod";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL_ID } from "../../shared/models";
import { chatRouter } from "./routers/chat";
import { publicProcedure, t } from "./trpc";

export const appRouter = t.router({
  health: publicProcedure.query(({ ctx }) => ({ ok: true, version: ctx.version })),
  echo: publicProcedure
    .input(z.object({ message: z.string().min(1) }))
    .query(({ input }) => ({ message: input.message })),
  // The model toggle reads from here; selection gets bound to a chat later.
  models: publicProcedure.query(() => ({
    available: CHAT_MODELS,
    defaultId: DEFAULT_CHAT_MODEL_ID,
  })),
  chat: chatRouter,
});

export type AppRouter = typeof appRouter;
