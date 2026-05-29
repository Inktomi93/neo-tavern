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
import {
  authConfigFromEnv,
  hasCsrfHeader,
  resolveIdentity,
  resolveUsername,
} from "./auth/trust-header";
import { createRegexService } from "./domain/_shared/regex";
import { ensureUser, provisionIdentity } from "./domain/_shared/users";
import { createAssetsService } from "./domain/assets";
import { createDebugService } from "./domain/debug";
import { createExportService } from "./domain/export";
// The auth seam (resolveUsername) reads env internally now — app.ts no longer needs the env import.
import { registerImportRoutes } from "./import-http";
import { debugAuthMiddleware, registerDebugRoutes } from "./observability/debug";
import { getLog } from "./observability/logger";
import { observability } from "./observability/middleware";
import type { Cas } from "./storage/cas";
import { type AuthContext, createContext, type Services } from "./trpc/context";
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
  const exportService = createExportService(db, cas);
  registerDebugRoutes(app, createDebugService(db), assetsService);
  registerImportRoutes(app, db, assetsService);

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
    await resolveUsername(c.req.raw.headers);

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

  // Export downloads (transport, not canon → generated on demand, not stored in CAS). Owner-scoped
  // via the same header-trust model as tRPC. PNG card / ST JSONL — the inverse of import.
  app.get("/api/export/character/:characterId", async (c) => {
    const username = await resolveUsername(c.req.raw.headers);
    const ownerId = await ensureUser(db, username);
    const result = await exportService.exportCharacter(ownerId, c.req.param("characterId"));
    if (!result) return c.notFound();
    return c.body(new Uint8Array(result.bytes), 200, {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    });
  });

  app.get("/api/export/chat/:chatId", async (c) => {
    const username = await resolveUsername(c.req.raw.headers);
    const ownerId = await ensureUser(db, username);
    const result = await exportService.exportChat(ownerId, c.req.param("chatId"));
    if (!result) return c.notFound();
    return c.body(result.text, 200, {
      "Content-Type": "application/jsonl; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    });
  });

  // The tRPC auth seam — the one place allowed to wire resolveIdentity (auth) + provisionIdentity
  // (domain/db) together. Produces the AuthContext the procedure ladder gates on:
  //   • no identity (AUTH_FALLBACK=deny, no credential) → null → authedProcedure 401s.
  //   • owner fallback → the admin owner, NO db touch + NO enabled gate (the raw-LAN-IP/zero-infra
  //     path is the owner by definition, not a revocable user — plan §2).
  //   • SSO identity (cookie/forward-header) → provisionIdentity resolves role + the enabled gate
  //     (disabled → dropped to unauthenticated).
  // (validateSessionCookie is injected here in commit 4 once the sessions service exists; until then
  // the cookie layer is inert and oidc falls through to the fallback.)
  async function buildAuthContext(headers: Headers): Promise<AuthContext> {
    const { identity, viaCookie, viaFallback } = await resolveIdentity(
      headers,
      authConfigFromEnv(),
    );
    const hasCsrf = hasCsrfHeader(headers);
    if (identity === null) {
      return { identity: null, viaCookie, hasCsrfHeader: hasCsrf, role: "user" };
    }
    if (viaFallback) {
      return { identity, viaCookie, hasCsrfHeader: hasCsrf, role: "admin" };
    }
    const { enabled, role } = await provisionIdentity(db, identity);
    if (!enabled) {
      return { identity: null, viaCookie, hasCsrfHeader: hasCsrf, role: "user" };
    }
    return { identity, viaCookie, hasCsrfHeader: hasCsrf, role };
  }

  app.all("/api/trpc/*", (c) =>
    fetchRequestHandler({
      endpoint: "/api/trpc",
      req: c.req.raw,
      router: appRouter,
      createContext: async ({ req }) =>
        createContext({ services, auth: await buildAuthContext(req.headers) }),
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
