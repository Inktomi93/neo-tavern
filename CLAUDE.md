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
- **Backend:** Hono · Drizzle + libSQL (**native `F32_BLOB` vectors + `libsql_vector_idx`**
  — no sqlite-vec; the Step-0 spike proved native vectors work) · Zod · tRPC ·
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
- **Corpus RAG (embedding + reranking) — STANCE CHANGED (May 2026, supersedes the original
  "no GPU" call):** we DO use the homelab's 2× RTX A6000. **BGE-M3** (1024-dim, 8192 ctx,
  CLS+normalize, no query prefix) for embeddings + **`onnx-community/bge-reranker-v2-m3-ONNX`**
  (fp16 cross-encoder) for reranking, both **in-process via onnxruntime-node's CUDA EP** (~24×
  CPU). CUDA-12 runtime is **vendored project-locally with uv** (`tools/cuda/`, `pnpm cuda:setup`)
  — not a system install. Real token counts use the **native `@anush008/tokenizers`** (the JS
  tokenizer is quadratic). Model weights cache to repo-local `.models/`. EMBED_DEVICE/EMBED_DTYPE
  configurable; CPU+fp32 stays the default for tests/queries (same model → one vector space).
  2-GPU split: embedder GPU 0, reranker GPU 1. Not married — `embeddings.model` tags every
  vector, so a model swap is a re-index away. Details: `docs/corpus-import.md`.

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
  dangling refs). **Phase 4.6 — embed → real search (IN PROGRESS):** 4.6.1 ✅ segmentation
  + identity-only card embed-text + embedding idempotency; 4.6.2 ✅ (code) native tokenizer,
  token-budget batching, owner-scoped knn, in-process CUDA embed pass — *first full GPU index
  running*; **4.6.3 ⏭ NEXT** CSLS hubness (per-entity-type) + bge-reranker two-stage + `discover`
  + `features/corpus-search` UI. ·
  **⏭ Migration 0005 (PENDING, specced):** enforce internal FKs (cascade policy) + move presets
  to content-versioning (copy-on-write) — fixes "nuke chat orphans 20k msgs" + preset-provenance
  bug. Full handoff: **`docs/handoff-0005-relational-fixes.md`**. ·
  **Phase 5** mode escape valve · **Phase 6** analytics (one chart at a time, only
  when there's a real question).

## Start here — fast orientation (new session, read this section)

**Where am I in the build?** ↑ See "Build phases & status" above + run **`TaskList`** (the live
task queue is the source of truth for in-flight work). **What's running/validated?** the recent
git log + the per-phase ✅ markers above.

**Read order** (don't read everything — pull what the task needs): this file →
`docs/build-plan.md` (order + spike results) → `docs/architecture.md` (the enforced layer cake —
read before touching imports) → `docs/data-model.md` (schema) → the doc for your area below.

**Doc map:**
- **`AGENTS.md`** — working doctrine: the enforcement is real, references are not the bible.
- **`docs/conventions.md`** — the recurring tooling/lint/logging traps + how past each (READ
  before fighting Biome/tsc: the index-key conflict, format-before-`check`, `tsx -e`, vector quirks).
- **`docs/build-plan.md`** — bottom-up build order + the de-risk spike results (all passed).
- **`docs/architecture.md`** — the enforced layer cake + folder map + the barrel tradeoff.
- **`docs/data-model.md`** — the full v1 database schema spec.
- **`docs/corpus-import.md`** — the ST import + RAG **answer key**: validated parsers + models
  to lift from **card-curator** & **st-bridge** (DON'T re-derive), the model stack, the divergence.
- **`docs/handoff-0005-relational-fixes.md`** — spec for the pending FK + preset-versioning migration.
- **`docs/observability.md`** — pino logging + the `curl`-able `/api/_debug/*` API.
- **`docs/sdk-notes.md`** — Agent SDK map + the `pnpm sdk:play` playground.
- **`docs/dependencies.md`** — deps (installed + deferred parking lot).
- **`references/README.md`** — reference repos (read, don't copy): external clones
  (astra-projecta/marinara-engine/sillytavern) **+ symlinks to our sibling repos
  `card-curator`/`st-bridge`** (the corpus/RAG answer-keys, in `development/`).
- **`README.md` / `ONBOARDING.md`** — how to run / human-teammate onboarding.

**Dev tools (don't reinvent — drive these):** `pnpm sdk:play` (Agent SDK probes — env/models/
latency), `pnpm embed:probe` (live BGE-M3), `pnpm import:st` / `pnpm embed:corpus[:gpu]` (corpus),
`pnpm cuda:setup` (uv CUDA). Inspect a running server via `/api/_debug/*` (logs/requests, gated
by `DEBUG_TOKEN`). `pnpm check` = green-to-ship (biome+tsc+arch+vitest), runs on pre-commit.

**Hard-won facts (a fresh session WILL waste time re-deriving these — each → its doc):**
- **Vectors are libSQL NATIVE `F32_BLOB` + `libsql_vector_idx`** — NO sqlite-vec. The index does
  full CRUD (UPSERT/UPDATE/targeted-DELETE all work + auto-maintain); the ONE footgun is bulk
  `DELETE FROM` (empties → next insert fails) → fix with `REINDEX <idx>`. Image vectors supported
  (CLIP, separate dim) — deferred by choice, not a limit. (docs/conventions.md, corpus-import.md)
- **Embedding/rerank run IN-PROCESS on GPU** via onnxruntime-node CUDA; CUDA-12 is vendored in
  `tools/cuda/` (uv, `pnpm cuda:setup`), models cache to `.models/`. (corpus-import, CLAUDE locked-decisions)
- **The transformers.js JS tokenizer is QUADRATIC** (12.7s/10k-tok) — use native `@anush008/tokenizers`. (#15)
- **references/ = answer-keys.** card-curator/st-bridge already solved the ST parsers + RAG —
  port `file:line`, don't re-derive. (corpus-import)
- **Commit directly to `main`**; **NEVER extract the Claude OAuth token** (ban risk). (CLAUDE locked-decisions)
- Internal links are plain `text` (only `ownerId` is a real FK today) — being hardened in 0005.

When unclear, ask. Don't re-litigate locked decisions — raise a question if you disagree.
