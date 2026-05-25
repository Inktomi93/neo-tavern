import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { env } from "./env";
import { registerDebugRoutes } from "./observability/debug";
import { logger } from "./observability/logger";
import { observability } from "./observability/middleware";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/router";
import { APP_VERSION } from "./version";

const IS_PROD = env.NODE_ENV === "production";

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
    createContext,
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
