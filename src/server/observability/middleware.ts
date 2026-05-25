import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { MiddlewareHandler } from "hono";
import { getLog, recordRequest, runInRequest } from "./logger";

const DEBUG_PREFIX = "/api/_debug";

/**
 * Per-request observability: assigns a request id, echoes it as `X-Request-Id`
 * (so a caller can grab it from the response and query
 * `/api/_debug/logs?requestId=…`), binds a request-scoped logger for the rest of
 * the call via AsyncLocalStorage, and logs one structured line per request.
 */
export const observability: MiddlewareHandler = (c, next) => {
  const requestId = randomUUID();
  c.header("X-Request-Id", requestId);
  const start = performance.now();

  return runInRequest(requestId, async () => {
    await next();

    const path = c.req.path;
    // Skip the introspection API's own traffic — that's just someone looking.
    if (path.startsWith(DEBUG_PREFIX)) {
      return;
    }

    const durationMs = Math.round(performance.now() - start);
    const method = c.req.method;
    const status = c.res.status;
    getLog().info({ method, path, status, durationMs }, "request");
    recordRequest({ id: requestId, method, path, status, durationMs, at: Date.now() });
  });
};
