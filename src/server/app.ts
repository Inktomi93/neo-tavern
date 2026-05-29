import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import sharp from "sharp";
import type { Db } from "../db/client";
import { isAssetHash } from "../shared/assets";
import { processMacros } from "../shared/macro";
import type { RegexPlacement, RegexScript } from "../shared/regex";
import { resolveUsername } from "./auth/trust-header";
import { createRegexService } from "./domain/_shared/regex";
import { createAssetsService } from "./domain/assets";
import { createDebugService } from "./domain/debug";
import { env } from "./env";
import { debugAuthMiddleware, registerDebugRoutes } from "./observability/debug";
import { getLog } from "./observability/logger";
import { observability } from "./observability/middleware";
import type { Cas } from "./storage/cas";
import { createContext, type Services } from "./trpc/context";
import { appRouter } from "./trpc/router";
import { APP_VERSION } from "./version";

// Macro/regex eval routes that need domain-layer imports (processMacros, createRegexService).
// Kept outside buildApp so the composition root stays as pure wiring.
function registerDomainDebugRoutes(router: Hono) {
  router.post("/macros/eval", async (c) => {
    const body = await c.req.json();
    const text = typeof body.text === "string" ? body.text : "";
    const options = typeof body.options === "object" && body.options !== null ? body.options : {};
    const result = processMacros(text, {
      ...options,
      onWarn: (msg: string, err?: unknown) => getLog().warn({ err }, msg),
    });
    return c.json({ result });
  });

  router.post("/regex/execute", async (c) => {
    const body = await c.req.json();
    const text = typeof body.text === "string" ? body.text : "";
    const scripts = Array.isArray(body.scripts) ? body.scripts : [];
    const placement = typeof body.placement === "string" ? body.placement : "AI_OUTPUT";
    const options = typeof body.options === "object" && body.options !== null ? body.options : {};

    const regexService = createRegexService();
    // Macro context is stubbed here — real RP variables are not available in the debug REPL.
    const ctx = {
      ...options,
      evaluateAST: () => "",
      evaluateString: () => "",
      onWarn: (msg: string, err?: unknown) => getLog().warn({ err }, msg),
    };

    const result = regexService.executeScripts(
      text,
      scripts as RegexScript[],
      placement as RegexPlacement,
      // biome-ignore lint/suspicious/noExplicitAny: debug REPL only — ctx is a stub
      ctx as any,
    );
    return c.json({ result });
  });
}

export function buildApp(db: Db, cas: Cas, services: Services, isProd: boolean) {
  const app = new Hono();

  // Must be first: assigns the request id + binds the request-scoped logger.
  app.use(observability);

  app.onError((err, c) => {
    getLog().error({ err, path: c.req.path }, "unhandled hono exception");
    return c.json({ error: "Internal Server Error" }, 500);
  });

  const assetsService = createAssetsService(db, cas);
  registerDebugRoutes(app, createDebugService(db), assetsService);

  const debugRouter = new Hono();
  debugRouter.use("/*", debugAuthMiddleware);

  // Extra dev/debug routes that depend on domain logic (entry layer can import domain,
  // observability infra cannot). Protected by the /api/_debug/* middleware from above.
  registerDomainDebugRoutes(debugRouter);

  app.route("/api/_debug", debugRouter);

  app.get("/api/healthz", (c) => c.json({ ok: true, version: APP_VERSION }));

  app.get("/api/blob/:hash", async (c) => {
    const hash = c.req.param("hash");
    if (!isAssetHash(hash)) return c.notFound();

    const meta = await assetsService.getMetadata(hash);
    if (!meta || !(await cas.exists(hash))) return c.notFound();

    const widthParam = c.req.query("w");
    const formatParam = c.req.query("f");

    // 1. Setup the raw disk stream
    let stream: NodeJS.ReadableStream = createReadStream(cas.blobPath(hash));
    let responseMime = meta.mime;
    let responseSize: string | undefined = meta.size.toString();

    // 2. JIT Transformation (Only if requested AND it's an image)
    if (widthParam && meta.mime.startsWith("image/")) {
      const width = Number.parseInt(widthParam, 10);
      const transformer = sharp().resize({ width, withoutEnlargement: true });

      if (formatParam === "webp") {
        transformer.webp({ quality: 80 });
        responseMime = "image/webp";
      }

      // Pipe the raw file through the C-bindings transformer
      stream = stream.pipe(transformer);
      responseSize = undefined; // Delete Content-Length since we are streaming a dynamic size
    }

    // 3. Convert to Web Stream and serve
    const webStream = Readable.toWeb(stream as import("stream").Readable) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": responseMime,
      "Cache-Control": "public, max-age=31536000, immutable",
    };
    if (responseSize) {
      headers["Content-Length"] = responseSize;
    }

    return c.body(webStream, 200, headers);
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
