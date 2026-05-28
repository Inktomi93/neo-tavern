import { createReadStream } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import type { Db } from "../db/client";
import { isAssetHash } from "../shared/assets";
import { processMacros } from "../shared/macro";
import type { MacroContext } from "../shared/macro/types";
import type { RegexPlacement, RegexScript } from "../shared/regex";
import { resolveUsername } from "./auth/trust-header";
import { createAssetsService } from "./domain/assets";
import { createDebugService } from "./domain/debug";
import { createRegexService } from "./domain/regex";
import { env } from "./env";
import { registerDebugRoutes } from "./observability/debug";
import { getLog } from "./observability/logger";
import { observability } from "./observability/middleware";
import type { Cas } from "./storage/cas";
import { createContext, type Services } from "./trpc/context";
import { appRouter } from "./trpc/router";
import { APP_VERSION } from "./version";

export function buildApp(db: Db, cas: Cas, services: Services, isProd: boolean) {
  const app = new Hono();

  // Must be first: assigns the request id + binds the request-scoped logger.
  app.use(observability);

  const assetsService = createAssetsService(db, cas);
  registerDebugRoutes(app, createDebugService(db), assetsService);

  // Extra dev/debug routes that depend on domain logic (entry layer can import domain,
  // observability infra cannot). Protected by the /api/_debug/* middleware from above.
  app.post("/api/_debug/macros/eval", async (c) => {
    const body = await c.req.json();
    const text = typeof body.text === "string" ? body.text : "";
    const options = typeof body.options === "object" && body.options !== null ? body.options : {};

    // Evaluate via Macro Engine
    const result = processMacros(text, options);
    return c.json({ result });
  });

  app.post("/api/_debug/regex/execute", async (c) => {
    const body = await c.req.json();
    const text = typeof body.text === "string" ? body.text : "";
    const scripts = Array.isArray(body.scripts) ? body.scripts : [];
    const placement = typeof body.placement === "string" ? body.placement : "AI_OUTPUT";
    const options = typeof body.options === "object" && body.options !== null ? body.options : {};

    const regexService = createRegexService();
    // process macros options need to be mapped if there are real RP variables
    const ctx = {
      ...options,
      evaluateAST: () => "",
      evaluateString: () => "",
    };

    const result = regexService.executeScripts(
      text,
      scripts as RegexScript[],
      placement as RegexPlacement,
      ctx as unknown as MacroContext,
    );
    return c.json({ result });
  });

  app.get("/api/healthz", (c) => c.json({ ok: true, version: APP_VERSION }));

  app.get("/api/blob/:hash", async (c) => {
    const hash = c.req.param("hash");
    if (!isAssetHash(hash)) return c.notFound();

    const meta = await assetsService.getMetadata(hash);
    if (!meta || !(await cas.exists(hash))) return c.notFound();

    // We use Web Streams (or Node streams cast to unknown) as Hono supports streaming natively.
    const stream = createReadStream(cas.blobPath(hash));
    return c.body(stream as unknown as ReadableStream, 200, {
      "Content-Type": meta.mime,
      "Content-Length": meta.size.toString(),
      "Cache-Control": "public, max-age=31536000, immutable", // it's CAS!
    });
  });

  app.post("/api/assets/upload", async (c) => {
    // Validate auth / tenancy seamlessly
    resolveUsername(c.req.raw.headers, env.NEO_PROXY_SECRET, env.DEFAULT_USER_HANDLE);

    const body = await c.req.parseBody();
    // biome-ignore lint/complexity/useLiteralKeys: TS requires index signature access
    const file = body["file"];
    if (!(file instanceof File)) {
      return c.json({ error: "Missing file" }, 400);
    }

    // biome-ignore lint/complexity/useLiteralKeys: TS requires index signature access
    const kind = body["kind"];
    if (kind !== "card" && kind !== "avatar" && kind !== "export") {
      return c.json({ error: "Invalid kind" }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = await assetsService.store(bytes, kind, file.type || "application/octet-stream");

    return c.json(stored);
  });

  app.all("/api/trpc/*", (c) =>
    fetchRequestHandler({
      endpoint: "/api/trpc",
      req: c.req.raw,
      router: appRouter,
      createContext: ({ req }) =>
        createContext({
          username: resolveUsername(req.headers, env.NEO_PROXY_SECRET, env.DEFAULT_USER_HANDLE),
          services,
        }),
      onError: ({ error, path, type }) => {
        getLog().error(
          { path, type, code: error.code, err: error.message },
          "trpc procedure error",
        );
      },
    }),
  );

  if (isProd) {
    app.use("/*", serveStatic({ root: "./dist/client" }));
    app.get("/*", serveStatic({ path: "./dist/client/index.html" }));
  }

  return app;
}
