# Observability

Two things: **structured logging** (pino) and an **in-process debug API** you
`curl` to get everything — no tailing files, no `head`/`tail`/`grep` roulette.

## Logging

- **pino**, structured JSON. The single logger lives in
  `src/server/observability/logger.ts`. Level via `LOG_LEVEL`
  (`fatal|error|warn|info|debug|trace|silent`, default `info`). **Per-op `debug` lines**
  (search `knn`/`find`/`discover`, the embed pass, hub scoring) are emitted at `debug` —
  run with `LOG_LEVEL=debug` to surface them (stdout + the `/api/_debug` ring). NOTE: each
  `pino.multistream` destination carries its OWN `level` tied to `LOG_LEVEL` — without that
  multistream defaults streams to `info` and silently drops `debug` even when the logger is
  `debug`. Don't remove the per-stream `level`.
- **`LOG_LEVEL` is also a runtime AppSetting** (`docs/subsystems/settings.md`): an admin can override it in
  the DB via `updateAppSettings`, and **per-call** readers (e.g. the agent-sdk env builder's
  debug-observability gate) pick it up immediately via `getAppConfig().logLevel`. The **boot-time
  logger init still reads `env.LOG_LEVEL`**, so the multistream `level` only changes on restart —
  live overrides affect per-call consumers, not the already-constructed pino streams.
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
- **Chat-turn signals (sdk-mode).** `consumeTurnStream` (the SDK message loop) logs each
  turn at metadata level: `"claude: turn complete"` (tokens, cost, **contextWindow**, ttft,
  cache 5m/1h split, stop/terminal reason) at info; `"claude: context compacted"` at info
  when a long chat auto-compacts; `"claude: rate-limited"` / `"claude: api retry"` at warn;
  and **`"claude: AUTH FAILURE during api retry (ban-risk canary)"` at ERROR** — that one is
  the locked-decision tripwire (never extract the token; watch auth), so it surfaces in
  `/api/_debug/errors`. The provider's own `--debug` + subprocess `stderr` are piped to
  `debug` only when `LOG_LEVEL=debug` (the injection audit — proves `0 hooks, 0 plugins`).
- **Chat-turn signals (raw-mode).** `runRawTurn` (OpenRouter) logs `"openrouter: raw turn complete"`
  (tokens/cost/cacheRead/duration) at info and `"openrouter: raw turn failed"` at error with the
  mapped `kind`/`retryable`. **Prompt assembly** logs `"chat: prompt assembled"` at debug (preset
  source, static/dynamic sizes, section ids, world-info matched keys) — metadata only, never the
  prompt text — so "why did/didn't this fire" is curl-able.
- **Chat-turn signal (domain, both modes).** The chat service logs `"chat turn complete"` at
  **info** (`chatId` + `seq`/`tokensIn`/`tokensOut`/`costUsd`/`contextWindow`/`finishReason`/
  `compactions`) — the one line that ties cost/tokens to a `chatId` at the default level (the
  provider-level lines above carry no `chatId`). The dry-run counterpart is the
  `chat.previewAssembly` tRPC query: the static/dynamic halves + assembly trace + resolved
  api/source/model a chat's next turn would use, without spending a turn.

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
| `GET /api/_debug/db/stats` | row counts per table |
| `GET /api/_debug/db/integrity` | FK / integrity check |
| `GET /api/_debug/db/chat/:id` | chat inspector — messages, variants, provenance, and the persisted `chat_events` (compaction/retry/rate-limit/status/auth) for one chat |
| `GET /api/_debug/db/assets` | CAS blob-store health (`domain/assets` fsck) — dangling (row, no blob) / corrupt (blob ≠ hash) / orphan (blob, no row); the curl-able twin of `pnpm assets:fsck` |

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
