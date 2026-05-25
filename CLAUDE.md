# CLAUDE.md

The mission and locked decisions for neo-tavern — auto-loaded each session so the
core vision doesn't get lost. For *how to work* see **`AGENTS.md`**; for the
enforced architecture see **`docs/architecture.md`**; deferred deps live in
**`docs/dependencies.md`**.

## The mission

A private, single-user RP frontend that replaces SillyTavern for my personal use,
hosted in my homelab behind authentik + caddy. **The killer feature is not chat.**
It's the **personal RAG / analytics layer over my entire RP corpus** — 400+
characters, hundreds of chats: semantic search, theme analysis, co-occurrence.
Chat is incidental; **the corpus tool is the product.** Build accordingly.

Single user (me). Authentik terminates auth and passes `X-Authentik-Username`; the
app trusts it. **Zero auth code in the app.** No multi-user, no permissions.

## RP philosophy (the non-obvious vision — easy to lose)

### YGWYG — "you get what you generate" (the core discipline)
Hardcore-ironman RP. In `sdk` mode (default): **no swipes, no edits to past
messages, no regenerating.** Each chat is one Claude Agent SDK session, append-only
linear messages. Whatever Claude generates IS canon — write your way through, or
nuke the chat. The SDK's forward-flowing session model fits this; we don't fight it.

### Mode escape valve (later, not MVP)
A chat has `mode: 'sdk' | 'raw'`. `sdk` = YGWYG, runs on the Max subscription (free).
`raw` = converted, paid per token via OpenRouter / direct Anthropic, swipes+edits
work. Conversion is **one-way**; fork-and-convert is preferred (keeps canon intact).
Imported ST chats land as `raw` from day zero (the SDK can't continue them).

### Other locked product principles
- **Append-only conversation log is the source of truth** — not a prompt template
  rebuilt from primitives every turn.
- **World Info is explicit attachment** (chat↔entry junction table), never
  keyword-scanned, never floating-depth. Author's note = a persistent editable
  system message, not a depth injection.
- **PNG character cards are transport only** (import/export); the DB row is
  canonical. Chats live in SQLite rows, not JSONL. Asset binaries on a mounted
  volume, referenced by hash.
- **Cache strategy (raw mode):** explicit `cache_control` breakpoints — stable
  system+character, rolling history every N turns, fresh tail. sdk mode: the SDK handles it.

## Locked decisions (current — supersedes the original brief where noted)

- **Runtime:** Node 24 (brief said 22; we target 24), pnpm 11. TypeScript, strict.
- **Backend:** Hono · Drizzle + libSQL (sqlite-vec for vectors) · Zod · tRPC ·
  `@anthropic-ai/claude-agent-sdk` (sdk chats + agent jobs) · `openai` → OpenRouter
  (raw / non-Claude).
- **Frontend:** React 19 · Vite · TanStack Router + Query · Tailwind v4 · shadcn
  (copied in-repo) · Zustand · React Hook Form + Zod.
- **Tooling:** Biome (one `biome.jsonc`) · dependency-cruiser (enforced layer cake) ·
  knip · vitest · husky pre-commit. `pnpm check` = green-to-ship. **No CI** (homelab).
- **Claude auth (CRITICAL):** sdk mode authenticates via the host's `claude login`
  (Max subscription) through the official Agent SDK runtime — **no API key, and
  NEVER extract the OAuth token.** Keychain extraction → direct API is what got an
  account banned (the `st-claude-proxy` lesson). Verified working (`apiKeySource: "none"`).
- **Deploy:** one Docker image into the authentik + caddy compose stack. Backend
  port **8788** (3000 is Open WebUI on this box).
- **Default chat model:** Opus 4.7; toggle catalog in `src/shared/models.ts`.

## What NOT to build (slop guard)

No settings pages for one-user/one-obvious-default toggles. No theme switcher (one
dark theme). No chub.ai browser. No TTS/STT/image-gen/sprites/expressions. No
47-field character editor before chat works. No skeleton-loader library (a spinner
is fine). No illustrated empty states. No pagination under ~1000 items. No
soft-delete trash bin. No tautological getById tests. Catch yourself building these
→ stop and ask.

## Build phases & status

- **Phase 1 — Scaffold:** ✅ Hono+tRPC server, React/Vite/TanStack client; the
  client→tRPC→server loop verified (dev + prod).
- **Providers + architecture:** ✅ Claude (sub) + OpenRouter adapters verified; the
  full layer cake stubbed and machine-enforced (server + client feature-slicing).
- **Phase 2 — Schema + first chat:** ⏭ NEXT. Implement the Drizzle schema (full v1
  spec in **`docs/data-model.md`** — characters/versions, personas, chats, messages,
  world books + junctions, presets, settings, assets, tags, embeddings), then
  `domain/chat` + `features/chat` + a tRPC router driving one YGWYG turn.
- **Phase 3** embeddings + semantic search · **Phase 4** ST corpus importer ·
  **Phase 5** mode escape valve · **Phase 6** analytics (one chart at a time, only
  when there's a real question).

## Where everything lives

- **`AGENTS.md`** — working doctrine: the enforcement is real, references are not the bible.
- **`docs/build-plan.md`** — bottom-up build order + the de-risk spike results (all passed).
- **`docs/architecture.md`** — the enforced layer cake + folder map + the barrel tradeoff.
- **`docs/data-model.md`** — the full v1 database schema spec (implemented in Phase 2).
- **`docs/observability.md`** — structured logging (pino) + the `curl`-able `/api/_debug/*` API.
- **`docs/dependencies.md`** — deferred-dependency parking lot.
- **`references/README.md`** — local domain reference clones (read, don't copy).
- **`README.md`** — how to run.

When unclear, ask. Don't re-litigate locked decisions — raise a question if you disagree.
