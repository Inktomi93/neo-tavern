# Observability

Two things: **structured logging** (pino) and an **in-process debug API** you
`curl` to get everything — no tailing files, no `head`/`tail`/`grep` roulette.

## Logging

- **pino**, structured JSON. The single logger lives in
  `src/server/observability/logger.ts`. Level via `LOG_LEVEL`
  (`fatal|error|warn|info|debug|trace|silent`, default `info`).
- **Use it, don't bypass it** (enforced — see below):
  - In a tRPC procedure: `ctx.log.info({ chatId }, "message appended")`.
  - Anywhere server-side: `import { getLog } from "../observability/logger"; getLog().warn(...)`.
  - `getLog()` returns a **request-scoped child logger** (carries `requestId`)
    when inside a request, else the base logger.
- **Logs are metadata, never RP content.** Log `{ chatId, messageId, role,
  contentLength, tokens }` — never the message text. Content lives in the DB;
  logs stay lean and private. (Redaction covers stray auth/secret fields; it is
  *not* a license to log bodies and scrub them.)
- Dev prints pretty (`dev:server` pipes through `pino-pretty`); prod emits JSON
  to stdout (captured by Docker).

## Debug API — `curl` it, don't tail

Every log + recent request also lands in a bounded in-memory ring buffer, served
over HTTP. **Gated by `DEBUG_TOKEN`:** unset → the API is `404` (disabled); set →
callers must present it via `x-debug-token:` header or `?token=`.

| Endpoint | Returns |
| --- | --- |
| `GET /api/_debug/info` | version, uptime, pid, memory, provider readiness |
| `GET /api/_debug/logs?level=&requestId=&q=&limit=` | recent structured logs (filtered) |
| `GET /api/_debug/errors?limit=` | recent error-level logs |
| `GET /api/_debug/requests?limit=` | recent requests (method, path, status, ms) |

Every response carries an **`X-Request-Id`** header — the correlation key:

```bash
# 1. hit the thing; grab the id from the response header
curl -si localhost:8788/api/chats | grep -i x-request-id      # → x-request-id: <RID>

# 2. pull exactly that request's logs
curl -s -H "x-debug-token: $DEBUG_TOKEN" \
  "localhost:8788/api/_debug/logs?requestId=<RID>" | jq

# what's broken right now?
curl -s -H "x-debug-token: $DEBUG_TOKEN" localhost:8788/api/_debug/errors | jq
# process health
curl -s -H "x-debug-token: $DEBUG_TOKEN" localhost:8788/api/_debug/info | jq
```

Set `DEBUG_TOKEN` in `.env` for local work. Leave it unset in prod images unless
you actually want the surface reachable (it's behind authentik + caddy regardless).

## Enforcement (so it stays clean)

- `noConsole` is `[]` for `src/server/**` — **raw `console` is a lint error**; use the logger.
- `noRestrictedImports` bans importing `pino`/`pino-pretty` outside
  `src/server/observability/**` — **no hand-rolled loggers**; everyone uses `getLog()` / `ctx.log`.
- `observability-is-foundation` (dependency-cruiser) keeps the module a foundation
  util — it never imports up into domain/drivers/client.

## Not now: OpenTelemetry

OTel is the 2026 standard, but it's built to **export to an external backend you
then view** (Grafana/Tempo/SigNoz). We want to `curl` the process, single-process,
no extra stack — which the debug API gives us. Revisit OTel only if/when there's
multi-process distributed work to trace (e.g. background jobs in Phase 3).
