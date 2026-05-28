import { serve } from "@hono/node-server";
import { createDb, runMigrations } from "../db/client";
import { buildApp } from "./app";
import { createCharacterService } from "./domain/character";
import { createChatService } from "./domain/chat";
import { createCorpusService } from "./domain/corpus";
import { createModelsService } from "./domain/models";
import { createPersonaService } from "./domain/persona";
import { createPresetService } from "./domain/preset";
import { createSearchService } from "./domain/search";
import { createSettingsService } from "./domain/settings";
import { createTagService } from "./domain/tag";
import { createWorldInfoService } from "./domain/world-info";
import { warmUpEmbedder } from "./embeddings/embedder";
import { warmUpImageEmbedder } from "./embeddings/image-embedder";
import { warmUpReranker } from "./embeddings/reranker";
import { warmUpSummarizer } from "./embeddings/summarizer";
import { env } from "./env";
import { getLog, logger } from "./observability/logger";
import { createCas } from "./storage/cas";
import type { Services } from "./trpc/context";
import { APP_VERSION } from "./version";

const IS_PROD = env.NODE_ENV === "production";

// Composition root: this is the one place allowed to wire db + auth + domain
// together. The db instance is created here and injected into the domain services;
// trpc only ever sees the services (the layer cake keeps db/auth out of trpc).
const db = await createDb(env.DATABASE_URL);
await runMigrations(db);
const cas = createCas(env.ASSETS_DIR);
const services: Services = {
  character: createCharacterService(db),
  chat: createChatService(db),
  corpus: createCorpusService(db),
  models: createModelsService(),
  persona: createPersonaService(db),
  preset: createPresetService(db),
  search: createSearchService(db),
  settings: createSettingsService(db),
  tag: createTagService(db),
  worldInfo: createWorldInfoService(db),
};

const app = buildApp(db, cas, services, IS_PROD);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port, prod: IS_PROD, version: APP_VERSION }, "neo-tavern listening");
  // Warm the embedder + reranker in the background (load + ORT kernel JIT) so the first real
  // request is fast. Fire-and-forget on purpose: a momentarily-busy shared GPU shouldn't keep the
  // server from booting — a failed warm-up just means that model lazy-loads on its first request
  // (WarmModel resets a failed load so it can retry). They idle-unload again after IDLE_UNLOAD_MIN.
  void Promise.allSettled([
    warmUpEmbedder(),
    warmUpImageEmbedder(),
    warmUpReranker(),
    warmUpSummarizer(),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        getLog().warn(
          { err: result.reason instanceof Error ? result.reason.message : String(result.reason) },
          "warm-up failed (model will lazy-load on first request)",
        );
      }
    }
  });
});
