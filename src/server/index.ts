import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { createDb, runMigrations } from "../db/client";
import { resolveUsername } from "./auth/trust-header";
import { createChatService } from "./domain/chat";
import { createCorpusService } from "./domain/corpus";
import { createModelsService } from "./domain/models";
import { createSearchService } from "./domain/search";
import { env } from "./env";
import { registerDebugRoutes } from "./observability/debug";
import { getLog, logger } from "./observability/logger";
import { observability } from "./observability/middleware";
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
  search: createSearchService(db),
};

const app = new Hono();

// Must be first: assigns the request id + binds the request-scoped logger.
app.use(observability);

// Gated in-process introspection — see docs/observability.md.
registerDebugRoutes(app);

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
});
