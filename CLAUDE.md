# CLAUDE.md

The mission and locked decisions for neo-tavern — auto-loaded each session so the core
vision doesn't get lost. This file holds **what is true and why** (mission, decisions,
hard-won facts). It does **not** track build status — that lives in the git log + the code
+ the one short backlog in `docs/build-plan.md`. For *how to work* see **`AGENTS.md`**;
for the enforced architecture see **`docs/architecture.md`**.

## The mission

A private, single-user RP frontend that replaces SillyTavern for my personal use, hosted in
my homelab behind authentik + caddy. **Two co-equal goals:** (1) a **polished RP chat
experience** — a *prettier SillyTavern* (think Marinara-Engine / AstraProjecta: real message
rendering, character/persona/world-info UX, swipes/edits, streaming), and (2) the **personal
RAG / analytics superpower** over my entire RP corpus — 300+ characters, hundreds of chats:
semantic search, theme analysis, co-occurrence. The corpus layer is the **killer
differentiator** no other ST client has; the chat is the daily driver. Both matter.

**Auth & tenancy.** Zero auth *logic* in the app, no sessions, no CSRF — stateless
per-request identity. Authentik terminates auth; identity = `X-Authentik-Username`, believed
**only when forwarded by caddy** (verified via an `X-Neo-Proxy` shared secret; caddy strips
client copies). No trusted header (direct-LAN/IP access, which I use often) → falls back to
`DEFAULT_USER_HANDLE` = the owner. **Multi-user is *designed* (a `users` table + `ownerId`
scoping enforced in the `domain` layer + per-user versioned `user_settings`), but only
single-user is *implemented* (one user row).** No permissions/roles/sharing/login UI —
ownership, not access control. **Deployment invariant:** don't expose port 8788 to an
untrusted network; if the app ever becomes directly reachable by untrusted clients, the
header-trust model changes.

## RP philosophy (the non-obvious vision — easy to lose)

### YGWYG — "you get what you generate" (a discipline, NOT a limitation)
Hardcore-ironman RP: in the default chat config, you write your way through or nuke the chat
— no reflexive re-rolling. **This is a chosen discipline, not a technical wall.** Swipes,
edits, and forks all *work* in every mode (we own the transcript via the DB-backed
SessionStore: truncate / edit / fork + resume + re-seed are all built and validated). YGWYG
is deliberately **not encoded in the schema** — it's a docs-level habit. The swipe/edit/fork
machinery exists and is exposed; whether you lean on it is up to you, chat by chat.
Append-only linear `messages` is the source of truth; the DB is canon.

### Locked product principles
- **Append-only conversation log is the source of truth** — not a prompt template rebuilt
  from primitives every turn. `seq` (not `createdAt`) is the canonical order.
- **World Info is explicit attachment** (chat↔entry + character-version↔entry junctions) with
  a per-entry `scope` that decides BOTH activation and placement: **`always`** → the
  **static** (cached) system prompt (byte-stable → paid once); **`keyword`** → injected into
  the **dynamic** system prompt (after the cache boundary, so the per-turn set never busts the
  cached prefix) when a key matches recent messages — *basic* case-insensitive whole-word
  match only. Candidate pool stays the **attached** entries (we never scan unattached lore,
  unlike ST). Deliberately NOT ST: no secondary-key AND/NOT logic, recursion, timed effects,
  probability, or floating-depth. Author's note = a persistent editable system message, not a
  depth injection.
- **PNG character cards are transport only** (import/export); the DB row is canonical. Chats
  live in SQLite rows, not JSONL. Asset binaries on a mounted volume, referenced by hash.
- **Session/runtime model (agent-sdk runner): STATELESS — one `query({resume})` per message.**
  Cold spawn ≈0.8s (measured); no long-lived subprocess to babysit, and editing stays trivial
  (every turn already resumes from a branch point). The DB-backed SessionStore is canon; the
  SDK's local JSONL is transient scratch. A warm streaming session (~5ms/msg, proven) is a
  future toggle, not built.
- **Multi-device by design (stateless → DB-is-truth).** No server-held chat state, so the same
  chat open on a PC and a phone **converges on reconnect/refresh** — that's intended, and works
  today. *Automatic* push (the other device updating live, no manual refresh, via an SSE
  subscription) is **designed, not yet built.**

### Provider modes (4 — the escape valve, all built)
A chat's next-turn routing = `chats.api` × `chats.source` × `chats.model`.
**`domain/chat/routing.ts` `resolveTurnRouting` is the single owner of model+provider
selection** — `send`/`swipe` never name a model or hardcode a runner. The four implemented
pairings:

| # | api | source | runner | what it is |
|---|---|---|---|---|
| 1 | `agent-sdk` | `max-pro-sub` | agent-sdk | Claude on the **Max sub** (free); `buildClaudeSdkEnv`. The default. |
| 2 | `agent-sdk` | `openrouter` | agent-sdk | **Paid Claude via OpenRouter's Anthropic skin** — REUSES the whole sdk pipeline; only the subprocess auth target differs. `buildClaudeOpenRouterEnv` (credential firewall). |
| 3 | `chat-completions` | `openrouter` | openrouter | `@openrouter/sdk` `chat.send` — the broad catalog. Per-block 5m `cache_control` on Anthropic. |
| 4 | `responses` | `openrouter` | openrouter | `@openrouter/sdk` `beta.responses` — OpenAI-style. |

Switching is `setProvider(chatId, api, source, model)` (in place; re-seeds or drops the SDK
session as the move requires) or `forkChat(atSeq, targetApi, targetSource)` (branch into a new
chat; canon is the only thing that crosses). "Swipe/edit/fork" is "resume from a chosen branch
point" regardless of provider. **The divide is economics, not capability:** mode 1 is free;
modes 2–4 are paid; mode 3 is the cost-controlled paid-Claude path (we own the 5m
cache_control) where mode 2 inherits the SDK's ~1h cache (≈2× the write cost).

## Locked decisions

- **Runtime:** Node 24, pnpm 11. TypeScript, strict.
- **Backend:** Hono · Drizzle + libSQL (**native `F32_BLOB` vectors + `libsql_vector_idx`** —
  no sqlite-vec) · Zod · tRPC · `@anthropic-ai/claude-agent-sdk` (agent-sdk runner) ·
  **`@openrouter/sdk`** (openrouter runner — chat-completions + responses; NOT the `openai`
  package).
- **Frontend:** React 19 · Vite · TanStack Router + Query · Tailwind v4 · shadcn (copied
  in-repo) · Zustand · React Hook Form + Zod.
- **Tooling:** Biome (one `biome.jsonc`) · dependency-cruiser (enforced layer cake) · knip ·
  vitest · husky pre-commit. **`pnpm check` = green-to-ship** (biome + tsc + arch + vitest).
  **No CI** (homelab).
- **Claude auth (CRITICAL):** the Max-sub path authenticates via the host's `claude login`
  through the official Agent SDK runtime — **no API key, and NEVER extract the OAuth token.**
  Keychain extraction → direct API is what got an account banned (the `st-claude-proxy`
  lesson). The mode-2 (OpenRouter-skin) subprocess sets a paid base URL, so its env builder
  **firewalls** the sub credential off (isolated config dir + nulled OAuth/identity tokens) so
  it can never leak to OpenRouter.
- **Caching (measured — supersedes any env-knob claim):** *agent-sdk runner* — the runtime
  places `cache_control` itself; the cached prefix survives resume *and* fork. Its TTL is
  **SDK-internal** (the `extended_cache_ttl` beta, effectively ~1h); **there is NO
  `FORCE_PROMPT_CACHING_5M` / `ENABLE_PROMPT_CACHING_1H` env knob** (that was wrong). On the
  free sub this is allowance, not dollars. *openrouter runner* — `cache_control` is
  **Anthropic-only** (others auto-cache); we set a per-block 5m directive on the **static**
  system block and **pin `provider:{order:["Anthropic"]}`** for Anthropic models (an unpinned
  route can land on an endpoint that ignores `cache_control` → 0 cache). 1h needs a beta header
  the SDK doesn't send and costs ~2×, so we stay at 5m.
- **Deploy:** one Docker image into the authentik + caddy compose stack. Backend port **8788**
  (3000 is Open WebUI on this box).
- **Default chat model:** Opus 4.7; catalog in `src/shared/models.ts` (agent-sdk) / the live
  OpenRouter catalog (openrouter runner).
- **Corpus RAG:** we DO use the homelab's 2× RTX A6000. **BGE-M3** (1024-dim, CLS+normalize)
  for embeddings + **`onnx-community/bge-reranker-v2-m3-ONNX`** (fp16 cross-encoder) for
  reranking, both **in-process via onnxruntime-node's CUDA EP** (~24× CPU). CUDA-12 is
  **vendored project-locally with uv** (`tools/cuda/`, `pnpm cuda:setup`). Real token counts
  use the **native `@anush008/tokenizers`** (the JS tokenizer is quadratic). Weights cache to
  repo-local `.models/`. CPU+fp32 is the default for tests/queries (same model → one vector
  space). Not married — `embeddings.model` tags every vector, so a model swap is a re-index
  away. Details: `docs/corpus-import.md`.

## What NOT to build (slop guard)

RP-frontend features ARE in scope — a real chat UX (markdown render, avatars, streaming,
swipes/edits), a character library/editor, persona + world-info UI, app shell/nav. Those are
*the work*, not slop. The guards target specific bloat:

No settings pages for one-user/one-obvious-default toggles. No theme switcher (one dark theme
— but make it *pretty*). No chub.ai browser. No TTS/STT/image-gen/sprites/expressions (unless
I ask). No 47-field character editor (build the editor we need, not ST's everything). No
skeleton-loader library (a spinner is fine). No illustrated empty states. No pagination under
~1000 items. No soft-delete trash bin. No tautological getById tests. Catch yourself building
these → stop and ask.

## Doc map

- **`AGENTS.md`** — working doctrine: the enforcement is real, references are not the bible.
- **`docs/architecture.md`** — the enforced layer cake + folder map. Read before touching imports.
- **`docs/conventions.md`** — recurring tooling/lint/logging traps (READ before fighting Biome/tsc).
- **`docs/build-plan.md`** — the de-risk spike results + the **deferred backlog** (what's left).
- **`docs/data-model.md`** — schema design notes (the *why*). The schema *itself* lives in
  `src/db/schema.ts` (heavily commented — that's the source of truth, not a parallel spec).
- **`docs/corpus-import.md`** — the ST import + RAG answer key (parsers/ranking lifted from
  card-curator & st-bridge).
- **`docs/observability.md`** — pino logging + the `curl`-able `/api/_debug/*` API.
- **`docs/sdk-notes.md`** — provider SDK field notes: Agent SDK (the runtime, event matrix,
  compaction, seeding, caching) + OpenRouter (chat-completions + responses).
- **`docs/ui-direction.md`** — the client UX plan (the next big chunk of work).
- **`docs/dependencies.md`** — deps (installed + deferred parking lot).
- **`references/README.md`** — reference repos (read, don't copy).
- **`README.md` / `ONBOARDING.md`** — how to run / onboarding.

## Where am I in the build? (don't narrate it here — look)

Status lives in: the **git log**, the **code** (`schema.ts` + migrations are the truth), and
the **deferred backlog in `docs/build-plan.md`**. The shape as of this writing: rails + the
corpus RAG product + the chat *backend* (prompt assembly, the 4 provider modes, swipes/edits/
fork/seeding) are built and green; the chat **frontend** (the surface that renders all of it)
is the main thing missing. Run `pnpm check` (must be green) and skim recent commits to confirm.

## Hard-won facts (a fresh session WILL waste time re-deriving these)

- **Provider routing = `chats.api` × `chats.source` × `chats.model`** (NOT the old
  `mode`/`provider` — retired in migration 0011). `resolveTurnRouting` owns selection; see the
  4-mode table above. `messages.model`/`provider` record what ACTUALLY ran (provenance).
- **Vectors are libSQL NATIVE `F32_BLOB` + `libsql_vector_idx`** — NO sqlite-vec. Full CRUD
  works + the index auto-maintains; the ONE footgun is bulk `DELETE FROM` (empties → next
  insert fails) → fix with `REINDEX`. (`docs/conventions.md`, `corpus-import.md`)
- **Embedding/rerank run IN-PROCESS on GPU** via onnxruntime-node CUDA; CUDA-12 is vendored in
  `tools/cuda/` (uv, `pnpm cuda:setup`); weights cache to `.models/`.
- **The transformers.js JS tokenizer is QUADRATIC** — use native `@anush008/tokenizers`.
- **references/ = answer-keys** (card-curator/st-bridge solved the ST parsers + RAG) — port
  `file:line`, don't re-derive.
- **Commit directly to `main`**; **NEVER extract the Claude OAuth token** (ban risk).
- **Internal links are enforced FKs** (migration 0007 — cascade policy in `docs/data-model.md`);
  polymorphic refs (`embeddings`/`taggables` entity refs) stay plain `text`.
- **OpenRouter key** lives in a gitignored `.env`, loaded via `dotenv override:true` (a stale
  shell export was a revoked key returning 401). The model catalog (`/models`) works without it.
- **Prompt structure lives in the preset `config` blob** (`PromptConfig`, `shared/prompt-config.ts`)
  — reorderable sections + a cache `boundary`, NOT normalized rows. `assemblePrompt`
  (`shared/prompt-assemble.ts`) → static/dynamic system halves.
- **Generation knobs are ONE provider-agnostic vocab** (`GenerationParams`, `shared/generation.ts`,
  in the preset `config.params`): temperature/topP/maxOutputTokens/thinking/effort/maxBudgetUsd/compaction/memory.
  Each runner translates it (agent-sdk → typed `thinking`/`effort`/`maxBudgetUsd` Options + env;
  openrouter → request params + `reasoning`); a knob a runner can't honor is a no-op. Reasoning on
  agent-sdk is the TYPED `effort`/`thinking` Options (verified), NOT the env vars; `effort` is
  model-gated (`xhigh`=Opus 4.7, `max`=Opus 4.6/4.7+Sonnet 4.6). (`docs/sdk-notes.md`)
- **Time is epoch-ms UTC EVERYWHERE.** `shared/time.ts` (Luxon) is the only parser; normalize at
  every provider/import boundary (Agent-SDK `resetsAt` is epoch SECONDS; ST imports parse as UTC;
  the old local-tz `new Date(y,mo,d)` was a bug). Client renders local via `Intl`. The lone ISO
  string we emit is the Agent SDK's session-frame `timestamp` (its shape). (`docs/conventions.md`)

When unclear, ask. Don't re-litigate locked decisions — raise a question if you disagree.
