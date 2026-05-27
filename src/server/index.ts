import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { createDb, runMigrations } from "../db/client";
import { resolveUsername } from "./auth/trust-header";
import { createAssetsService } from "./domain/assets";
import { createChatService } from "./domain/chat";
import { createCorpusService } from "./domain/corpus";
import { createDebugService } from "./domain/debug";
import { createModelsService } from "./domain/models";
import { createPresetService } from "./domain/preset";
import { createSearchService } from "./domain/search";
import { warmUpEmbedder } from "./embeddings/embedder";
import { warmUpReranker } from "./embeddings/reranker";
import { warmUpSummarizer } from "./embeddings/summarizer";
import { env } from "./env";
import { registerDebugRoutes } from "./observability/debug";
import { getLog, logger } from "./observability/logger";
import { observability } from "./observability/middleware";
import { createCas } from "./storage/cas";
import { createContext, type Services } from "./trpc/context";
import { appRouter } from "./trpc/router";
import { APP_VERSION } from "./version";

const IS_PROD = env.NODE_ENV === "production";

// Composition root: this is the one place allowed to wire db + auth + domain
// together. The db instance is created here and injected into the domain services;
// trpc only ever sees the services (the layer cake keeps db/auth out of trpc).
const db = await createDb(env.DATABASE_URL);
await runMigrations(db);
const services: Services = {
  chat: createChatService(db),
  corpus: createCorpusService(db),
  models: createModelsService(),
  preset: createPresetService(db),
  search: createSearchService(db),
};

const app = new Hono();

// Must be first: assigns the request id + binds the request-scoped logger.
app.use(observability);

// Gated in-process introspection — see docs/observability.md. The debug service adds the
// /api/_debug/db/* read-only DB inspector (counts, FK/integrity, chat provenance dump); the assets
// service adds /api/_debug/db/assets (CAS blob-store health — dangling/corrupt/orphan).
registerDebugRoutes(
  app,
  createDebugService(db),
  createAssetsService(db, createCas(env.ASSETS_DIR)),
);

app.get("/api/healthz", (c) => c.json({ ok: true, version: APP_VERSION }));

app.all("/api/trpc/*", (c) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    // Resolve identity per-request at the auth seam, then hand the request the
    // resolved username + the shared services.
    createContext: ({ req }) =>
      createContext({
        username: resolveUsername(req.headers, env.NEO_PROXY_SECRET, env.DEFAULT_USER_HANDLE),
        services,
      }),
    // Central error logging — without this, procedure throws (stale-seq, NOT_FOUND, …)
    // never hit the log/ring, so /api/_debug/errors stays empty. Metadata only (no bodies).
    onError: ({ error, path, type }) => {
      getLog().error({ path, type, code: error.code, err: error.message }, "trpc procedure error");
    },
  }),
);

if (IS_PROD) {
  // Serve the built client, then fall back to index.html so client-side routes
  // (e.g. /chats/abc) resolve on a hard refresh instead of 404ing.
  app.use("/*", serveStatic({ root: "./dist/client" }));
  app.get("/*", serveStatic({ path: "./dist/client/index.html" }));
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port, prod: IS_PROD, version: APP_VERSION }, "neo-tavern listening");
  // Warm the embedder + reranker in the background (load + ORT kernel JIT) so the first real
  // request is fast. Fire-and-forget on purpose: a momentarily-busy shared GPU shouldn't keep the
  // server from booting — a failed warm-up just means that model lazy-loads on its first request
  // (WarmModel resets a failed load so it can retry). They idle-unload again after IDLE_UNLOAD_MIN.
  void Promise.allSettled([warmUpEmbedder(), warmUpReranker(), warmUpSummarizer()]).then(
    (results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          getLog().warn(
            { err: result.reason instanceof Error ? result.reason.message : String(result.reason) },
            "warm-up failed (model will lazy-load on first request)",
          );
        }
      }
    },
  );
});
