import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL_ID } from "../../shared/models";
import type { Context } from "./context";

const t = initTRPC.context<Context>().create();

const publicProcedure = t.procedure;

export const appRouter = t.router({
  health: publicProcedure.query(({ ctx }) => ({ ok: true, version: ctx.version })),
  echo: publicProcedure
    .input(z.object({ message: z.string().min(1) }))
    .query(({ input }) => ({ message: input.message })),
  // The model toggle reads from here; selection gets bound to a chat in Phase 2.
  models: publicProcedure.query(() => ({
    available: CHAT_MODELS,
    defaultId: DEFAULT_CHAT_MODEL_ID,
  })),
});

export type AppRouter = typeof appRouter;
