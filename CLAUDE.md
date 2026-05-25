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

**Auth & tenancy.** Zero auth *logic* in the app, no sessions, no CSRF — stateless
per-request identity. Authentik terminates auth; identity = `X-Authentik-Username`,
believed **only when forwarded by caddy** (verified via an `X-Neo-Proxy` shared
secret; caddy strips client copies). No trusted header (direct-LAN/IP access, which I
use often) → falls back to `DEFAULT_USER_HANDLE` = the owner. **Multi-user is
*designed* (a `users` table + `ownerId` scoping enforced in the `domain` layer +
per-user versioned `user_settings`), but only single-user is *implemented* (one user
row).** No permissions/roles/sharing/login UI — ownership, not access control.
**Deployment invariant:** don't expose port 8788 to an untrusted network; if the app
ever becomes directly reachable by untrusted clients, the header-trust model changes.

## RP philosophy (the non-obvious vision — easy to lose)

### YGWYG — "you get what you generate" (the core discipline)
Hardcore-ironman RP. In `sdk` mode (default): **no swipes, no edits, no regen.** Not
because the SDK forbids it — we *proved* it doesn't: the session transcript is ours
via the DB-backed SessionStore, so truncate / edit / fork + resume all work (validated
in `CACHE=1 pnpm sdk:play`). The constraint is **chosen discipline, not a wall.** The
swipe/edit machinery exists and stays switched OFF in sdk-mode by default; whatever
Claude generates IS canon — write your way through, or nuke the chat. Append-only
linear messages; the DB is the source of truth. (Earlier framing called this "the
SDK's forward-flowing model fits" — that was copium around a false "can't edit" claim;
YGWYG is a default toggle a chat can leave, not a cage.)

### Mode escape valve (later, not MVP)
A chat has `mode: 'sdk' | 'raw'`. `sdk` = YGWYG, runs on the Max subscription (free).
`raw` = paid per token via OpenRouter / direct Anthropic. Swipes/edits/forks are the
*same move in both modes* — a resume from a chosen branch point — so the divide isn't
capability, it's economics + cleanliness: `raw` is where they're **first-class and
cache-cheap** (we own the messages array + `cache_control`), whereas an sdk-mode edit
re-caches the tail (the prefix cache survives only a clean cut, measured). A swipe/fork
= a new session branched at a `seq`; the original stays intact. Conversion is
**one-way**; fork-and-convert is preferred. **Imported ST chats are NOT forced to `raw`**
(superseded — the old framing was "the SDK can't continue them"). We own the transcript via
the DB-backed SessionStore, so an imported chat can be continued in sdk-mode by seeding
`session_entries` from its `messages`; mode is a per-chat choice, not an import constraint.
Imported swipes are preserved faithfully in `message_variants` (built Phase 4) regardless of
mode.

### Other locked product principles
- **Append-only conversation log is the source of truth** — not a prompt template
  rebuilt from primitives every turn.
- **World Info is explicit attachment** (chat↔entry junction table), never
  keyword-scanned, never floating-depth. Author's note = a persistent editable
  system message, not a depth injection.
- **PNG character cards are transport only** (import/export); the DB row is
  canonical. Chats live in SQLite rows, not JSONL. Asset binaries on a mounted
  volume, referenced by hash.
- **Session/runtime model (sdk mode): STATELESS — one `query({resume})` per
  message.** Cold spawn ≈0.8s (measured, `LATENCY=1 pnpm sdk:play`); no long-lived
  subprocess to babysit, and editing stays trivial (every turn already resumes from a
  branch point). A warm streaming session (~5ms/msg, proven) is a future toggle, not
  built. The DB-backed SessionStore is canon; the SDK's local JSONL is transient scratch.
- **Cache strategy:** sdk mode — the runtime places `cache_control`, defaults to a
  **1h TTL** (env-overridable: `FORCE_PROMPT_CACHING_5M` / `ENABLE_PROMPT_CACHING_1H`),
  and the cached prefix survives resume *and* fork (measured) — so stateless costs no
  cache. raw mode — we place explicit breakpoints: stable system+character, rolling
  history every N turns, fresh tail.

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
- **Phase 2 — Schema + first chat:** ✅ DONE (schema + first YGWYG turn end-to-end,
  live-verified; + shadcn component system). The Drizzle schema (full v1
  spec in **`docs/data-model.md`** — characters/versions, personas, chats, messages,
  world books + junctions, presets, settings, assets, tags, embeddings), then
  `domain/chat` + `features/chat` + a tRPC router driving one YGWYG turn.
- **Phase 3** embeddings + semantic search (**3a ✅** foundation: BGE-M3 + libSQL
  F32_BLOB vectors proven; ranking polish + UI fold into Phase 4.6) ·
  **Phase 4 — ST corpus importer ✅ DONE** (4.1–4.5): pure card + chat-JSONL parsers
  (`domain/import`), `message_variants`/branch schema, orchestration (copy-on-write
  versions, char-wide branch resolution, idempotent), and the `pnpm import:st` runner —
  validated on the real corpus (**309 chars · 20,845 msgs · 71,187 variants**, zero
  dangling refs). **⏭ NEXT: 4.6** — embed the imported corpus → real search (segmentation,
  CSLS, hybrid, rerank, `discover`, `features/corpus-search` UI). ·
  **Phase 5** mode escape valve · **Phase 6** analytics (one chart at a time, only
  when there's a real question).

## Where everything lives

- **`AGENTS.md`** — working doctrine: the enforcement is real, references are not the bible.
- **`docs/build-plan.md`** — bottom-up build order + the de-risk spike results (all passed).
- **`docs/architecture.md`** — the enforced layer cake + folder map + the barrel tradeoff.
- **`docs/data-model.md`** — the full v1 database schema spec (implemented in Phase 2).
- **`docs/corpus-import.md`** — the ST import + RAG answer key: validated parsers to
  port from **card-curator** & **st-bridge** (don't re-derive), + the BGE-M3 divergence.
- **`docs/observability.md`** — structured logging (pino) + the `curl`-able `/api/_debug/*` API.
- **`docs/sdk-notes.md`** — Agent SDK map (knobs, messages, hooks, debug) + the `pnpm sdk:play` playground.
- **`docs/dependencies.md`** — deferred-dependency parking lot.
- **`references/README.md`** — local domain reference clones (read, don't copy).
- **`README.md`** — how to run.

When unclear, ask. Don't re-litigate locked decisions — raise a question if you disagree.
