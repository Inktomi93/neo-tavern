import { z } from "zod";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL_ID } from "../../shared/models";
import { chatRouter } from "./routers/chat";
import { corpusRouter, searchRouter } from "./routers/search";
import { publicProcedure, t } from "./trpc";

export const appRouter = t.router({
  health: publicProcedure.query(({ ctx }) => ({ ok: true, version: ctx.version })),
  echo: publicProcedure
    .input(z.object({ message: z.string().min(1) }))
    .query(({ input }) => ({ message: input.message })),
  // sdk-mode model toggle (the static Claude catalog). Selection gets bound to a chat later.
  models: publicProcedure.query(() => ({
    available: CHAT_MODELS,
    defaultId: DEFAULT_CHAT_MODEL_ID,
  })),
  // raw-mode model picker — the LIVE OpenRouter catalog (fetched + cached via domain → provider).
  rawModels: publicProcedure.query(({ ctx }) => ctx.services.models.rawCatalog()),
  // OpenRouter account info (the SDK's analytics/credits/providers/endpoints/generations surface).
  orCredits: publicProcedure.query(({ ctx }) => ctx.services.models.credits()),
  orActivity: publicProcedure.query(({ ctx }) => ctx.services.models.activity()),
  orProviders: publicProcedure.query(({ ctx }) => ctx.services.models.providers()),
  orEndpoints: publicProcedure
    .input(z.object({ model: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.services.models.endpoints(input.model)),
  orGenerationCost: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.services.models.generationCost(input.id)),
  chat: chatRouter,
  corpus: corpusRouter,
  search: searchRouter,
});

export type AppRouter = typeof appRouter;
