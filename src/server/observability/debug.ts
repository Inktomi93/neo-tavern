import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";
import type { Hono } from "hono";
import { env } from "../env";
import { APP_VERSION } from "../version";
import { logRing, recentRequests } from "./logger";

const ERROR_LEVEL = 50; // pino numeric level for "error"

function levelValue(name: string | undefined): number {
  if (name === undefined) {
    return 0;
  }
  const levels: Record<string, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
  };
  return levels[name] ?? 0;
}

function tokenMatches(provided: string | undefined): boolean {
  const expected = env.DEBUG_TOKEN;
  if (expected === undefined || provided === undefined) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fieldOf(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function toLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : fallback;
}

/**
 * In-process introspection — curl it instead of tailing files. Single gate:
 * DEBUG_TOKEN must be set AND presented (header `x-debug-token` or `?token=`).
 * No localhost branch: behind Caddy the client IP is Caddy's, so IP checks lie.
 */
export function registerDebugRoutes(app: Hono): void {
  app.use("/api/_debug/*", async (c, next) => {
    if (env.DEBUG_TOKEN === undefined) {
      return c.json({ error: "debug API disabled — set DEBUG_TOKEN to enable" }, 404);
    }
    const provided = c.req.header("x-debug-token") ?? c.req.query("token");
    if (!tokenMatches(provided)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
    return undefined;
  });

  app.get("/api/_debug/info", (c) =>
    c.json({
      version: APP_VERSION,
      nodeEnv: env.NODE_ENV,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      providers: { openrouter: env.OPENROUTER_API_KEY !== undefined },
    }),
  );

  app.get("/api/_debug/logs", (c) => {
    const limit = toLimit(c.req.query("limit"), 200);
    const minLevel = levelValue(c.req.query("level"));
    const requestId = c.req.query("requestId");
    const q = c.req.query("q");

    const logs: Record<string, unknown>[] = [];
    for (const line of logRing.recent(2000)) {
      if (q !== undefined && !line.includes(q)) {
        continue;
      }
      const record = parseLine(line);
      if (record === null) {
        continue;
      }
      if (Number(fieldOf(record, "level") ?? 0) < minLevel) {
        continue;
      }
      if (requestId !== undefined && fieldOf(record, "requestId") !== requestId) {
        continue;
      }
      logs.push(record);
      if (logs.length >= limit) {
        break;
      }
    }
    return c.json({ count: logs.length, logs });
  });

  app.get("/api/_debug/errors", (c) => {
    const limit = toLimit(c.req.query("limit"), 100);
    const errors: Record<string, unknown>[] = [];
    for (const line of logRing.recent(2000)) {
      const record = parseLine(line);
      if (record !== null && Number(fieldOf(record, "level") ?? 0) >= ERROR_LEVEL) {
        errors.push(record);
      }
      if (errors.length >= limit) {
        break;
      }
    }
    return c.json({ count: errors.length, errors });
  });

  app.get("/api/_debug/requests", (c) =>
    c.json({ requests: recentRequests(toLimit(c.req.query("limit"), 100)) }),
  );
}
