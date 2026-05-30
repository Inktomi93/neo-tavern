import { z } from "zod";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL_ID } from "../../shared/models";
import { analyticsRouter } from "./routers/analytics";
import { characterRouter } from "./routers/character";
import { chatRouter } from "./routers/chat";
import { credentialsRouter } from "./routers/credentials";
import { personaRouter } from "./routers/persona";
import { presetRouter } from "./routers/preset";
import { corpusRouter, searchRouter } from "./routers/search";
import { settingsRouter } from "./routers/settings";
import { tagRouter } from "./routers/tag";
import { userAdminRouter } from "./routers/user-admin";
import { worldInfoRouter } from "./routers/world-info";
import { authedProcedure, publicProcedure, t } from "./trpc";

export const appRouter = t.router({
  analytics: analyticsRouter,
  character: characterRouter,
  persona: personaRouter,
  health: publicProcedure.query(({ ctx }) => ({ ok: true, version: ctx.version })),
  echo: publicProcedure
    .input(z.object({ message: z.string().min(1) }))
    .query(({ input }) => ({ message: input.message })),
  // sdk-mode model toggle (the static Claude catalog). Selection gets bound to a chat later.
  models: publicProcedure.query(() => ({
    available: CHAT_MODELS,
    defaultId: DEFAULT_CHAT_MODEL_ID,
  })),
  // raw-mode model picker — the LIVE OpenRouter catalog. Public, like `models`: it's a catalog (no
  // account/key needed to browse), not per-user data.
  rawModels: publicProcedure.query(({ ctx }) => ctx.services.models.rawCatalog()),
  // OpenRouter account/usage surface. authedProcedure (NOT admin): these are per-user — today they
  // read the host key, but the model is heading to per-user bring-your-own keys (the host key is a
  // temporary fallback). The ONLY thing admin/owner-gated is mode 1 (max-pro-sub), enforced at
  // turn-time by the credential resolver (§8) — not a procedure tier.
  orCredits: authedProcedure.query(({ ctx }) => ctx.services.models.credits()),
  orActivity: authedProcedure.query(({ ctx }) => ctx.services.models.activity()),
  orProviders: authedProcedure.query(({ ctx }) => ctx.services.models.providers()),
  orEndpoints: authedProcedure
    .input(z.object({ model: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.services.models.endpoints(input.model)),
  orGenerationCost: authedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.services.models.generationCost(input.id)),
  chat: chatRouter,
  credentials: credentialsRouter,
  preset: presetRouter,
  corpus: corpusRouter,
  search: searchRouter,
  settings: settingsRouter,
  tag: tagRouter,
  userAdmin: userAdminRouter,
  worldInfo: worldInfoRouter,
});

export type AppRouter = typeof appRouter;
