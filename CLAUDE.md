# CLAUDE.md

The mission and locked decisions for neo-tavern — auto-loaded each session so the
core vision doesn't get lost. For *how to work* see **`AGENTS.md`**; for the
enforced architecture see **`docs/architecture.md`**; deferred deps live in
**`docs/dependencies.md`**.

## The mission

A private, single-user RP frontend that replaces SillyTavern for my personal use,
hosted in my homelab behind authentik + caddy. **Two co-equal goals:** (1) a
**polished RP chat experience** — a *prettier SillyTavern* for me (think
Marinara-Engine / AstraProjecta: real message rendering, character/persona/world-info
UX, swipes/edits, streaming), and (2) the **personal RAG / analytics superpower** over
my entire RP corpus — 400+ characters, hundreds of chats: semantic search, theme
analysis, co-occurrence. The corpus layer is the **killer differentiator** no other ST
client has; the chat is the daily driver. Chat is **NOT** incidental — both matter.
(STANCE CHANGED, owner-approved: the original brief framed chat as incidental and the
corpus as "the product"; that's superseded — the corpus is built + validated, now the RP
frontend gets first-class polish too.)

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
- **World Info is explicit attachment** (chat↔entry junction table) with a per-entry
  `scope` that decides BOTH activation and placement: **`always`** → the **static**
  (cached) system prompt (byte-stable → paid once); **`keyword`** → injected into the
  **dynamic** system prompt (after `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, so the per-turn set
  never busts the cached prefix) when one of its keys matches recent messages — *basic*
  case-insensitive whole-word match only. Candidate pool stays the **attached** entries
  (we never scan unattached lore, unlike ST's bound-world scan). Deliberately NOT ST: no
  secondary-key AND/NOT logic, recursion, timed effects, probability, or floating-depth.
  Author's note = a persistent editable system message, not a depth injection. (STANCE
  REFINED, owner-approved: the original "never keyword-scanned" is superseded — *basic*
  keyword is in; the rejected complexity is not.)
- **PNG character cards are transport only** (import/export); the DB row is
  canonical. Chats live in SQLite rows, not JSONL. Asset binaries on a mounted
  volume, referenced by hash.
- **Session/runtime model (sdk mode): STATELESS — one `query({resume})` per
  message.** Cold spawn ≈0.8s (measured, `LATENCY=1 pnpm sdk:play`); no long-lived
  subprocess to babysit, and editing stays trivial (every turn already resumes from a
  branch point). A warm streaming session (~5ms/msg, proven) is a future toggle, not
  built. The DB-backed SessionStore is canon; the SDK's local JSONL is transient scratch.
- **Cache strategy (measured, May 2026 — supersedes the earlier env-knob claim):**
  *Agent-SDK runner* (Claude Sub + Claude API) — the runtime places `cache_control` itself
  and the cached prefix survives resume *and* fork (measured), so stateless costs no cache.
  Its TTL is **SDK-internal** (the `extended_cache_ttl` beta — effectively ~1h; there is **no**
  `FORCE_PROMPT_CACHING_5M`/`ENABLE_PROMPT_CACHING_1H` env knob — that was wrong). On the FREE
  sub this is allowance, not dollars; for **paid Claude via OpenRouter the 1h write costs ~2×**,
  so the cost-controlled paid-Claude path is the **OpenRouter Chat Completions** runner.
  *OpenRouter runner* (chat-completions / responses) — caching is **Anthropic-only** (`cache_control`
  is an Anthropic feature; other providers auto-cache). We place a **per-block `cache_control` on the
  static system block** at the **5m default TTL** (1h needs the `anthropic-beta: extended-cache-ttl`
  header the SDK doesn't send → no cache; and costs ~2×), and **pin `provider:{order:["Anthropic"]}`**
  for Anthropic models (an unpinned route can land on an endpoint that ignores `cache_control` —
  measured: 0 cache). Proven: cacheWrite→cacheRead, ~11× cheaper on the read. (History-depth
  breakpoints à la SillyTavern → #48.)

## Locked decisions (current — supersedes the original brief where noted)

- **Runtime:** Node 24 (brief said 22; we target 24), pnpm 11. TypeScript, strict.
- **Backend:** Hono · Drizzle + libSQL (**native `F32_BLOB` vectors + `libsql_vector_idx`**
  — no sqlite-vec; the Step-0 spike proved native vectors work) · Zod · tRPC ·
  `@anthropic-ai/claude-agent-sdk` (sdk chats + agent jobs) · **`@openrouter/sdk`** (raw /
  non-Claude — the OFFICIAL OpenRouter SDK + Responses API; the `openai` package was removed,
  Phase 5).
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

> **Reframed with the chat-first stance:** RP-frontend features are now IN scope — a real
> chat UX (markdown render, avatars, streaming, swipes/edits), a character library/editor,
> persona + world-info UI, app shell/nav. Those are *the work*, not slop. The guards below
> still hold (they target specific bloat, not the RP frontend).

No settings pages for one-user/one-obvious-default toggles. No theme switcher (one
dark theme — but make it *pretty*). No chub.ai browser. No TTS/STT/image-gen/sprites/
expressions (unless I ask). No 47-field character editor *before a usable chat exists*
(build the editor we need, not ST's everything). No skeleton-loader library (a spinner
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
  dangling refs). **Phase 4.6 — embed → real search ✅ DONE:** 4.6.1 ✅ segmentation
  + identity-only card embed-text + embedding idempotency; 4.6.2 ✅ (code) native tokenizer,
  token-budget batching, owner-scoped knn, in-process CUDA embed pass — *first full GPU index
  running*; **4.6.3a ✅** CSLS hubness (per-entity-type): `embeddings.hub_score` (migration
  0005) + `domain/corpus/hubness` precompute (`pnpm csls`) + query-time `adjusted_dist =
  max(0, dist−1+hub)` re-rank in `domain/search` — validated on the real corpus (8225 vectors;
  generic "match-everything" cards demoted, distinctive cards surfaced); **4.6.3b ✅** two-stage
  cross-encoder rerank: `embeddings.source_text` (migration 0006) stored by the embed pass +
  `pnpm corpus:backfill-source-text`, `embeddings/reranker` (bge-reranker-v2-m3 ONNX, fp16,
  max_length 1024, batched, device via `RERANK_DEVICE`), `knn({rerank:true})` over-fetches the
  CSLS pool → cross-encoder → top-n (GPU-validated, `pnpm rerank:probe`); **4.6.3c ✅** the
  killer feature `discover` — `search.discover()` searches chat segments, groups by character,
  returns characters ranked by their best matching conversation + snippet evidence + card meta
  (real-corpus validated, `pnpm discover:probe`: "arena fight"/"first kiss" → thematically
  correct characters); **4.6.3d ✅** `features/corpus-search` UI — the `/corpus` route, a
  two-mode (Discover | Find) search box with a rerank toggle; search state (mode/q/rerank)
  lives in the URL (shareable); `search.find` enriches knn hits (names + snippets) for display.
  **The corpus tool — the product — is now end-to-end usable.** ·
  **Migration 0007 ✅ DONE:** internal FKs now enforced (cascade policy — CASCADE down
  containment, RESTRICT on pinned versions = archive-don't-delete, SET NULL on circular/optional/
  self-refs) + presets moved to content-versioning (`presets`/`preset_versions` triad,
  copy-on-write) + `messages`/`message_variants.reasoningEffort`. Validated on the real corpus
  (`foreign_key_check` 0; importer re-runs idempotent under enforced FKs); exposed + fixed a
  circular-FK bug in `domain/chat` createChat. Spec: `docs/handoff-relational-fixes.md`. ·
  **Phase 5 prepwork ✅ (SDK runtime hardening):** the chat turn now consumes the FULL Agent
  SDK message stream — `consumeTurnStream` (split from `runChatTurn` for unit-testing)
  classifies compaction / api_retry / rate_limit / auth_status / error-results into a
  structured `events[]` + a **provider-agnostic `TurnError`** (`kind` = rate_limit |
  auth_failed | billing | … — the vocabulary raw-mode reuses), with per-event logging (auth
  failure → ERROR, the ban canary). `domain/chat` does an **atomic send** (rolls the user
  message back on failure → `SendResult{status:"error"}`). Migration **0008** persists turn
  metadata (contextWindow/ttft/cache 5m·1h split/terminalReason/apiErrorStatus). Fixed a real
  `session_entries` uuid-dedup bug (NULL subpath defeated the unique index → `""` sentinel).
  **Compaction + seeding measured empirically** (`pnpm sdk:compaction`): boundary persists as a
  `system`/`compact_boundary` marker + a synthetic-`user` LLM summary (no `preserved_messages`
  relink), and the summary's "/tmp transcript" pointer is dead under `tools:[]` → long-RP wants
  owned context. Matrix + findings: `docs/sdk-notes.md`. ·
  **Phase 5 keystone ✅ (prompt assembly):** the chat turn now sends a real character system
  prompt (it sent NONE before). A prompt is a versioned, reorderable list of **sections** —
  literal blocks (with `{{macros}}`) + markers (char_description/personality/scenario/dialogue/
  char_system/post_history, persona, world_info) + a `boundary` section — living in the preset
  `config` blob (`shared/prompt-config.ts`, the `PromptConfig` Zod; default = `DEFAULT_PROMPT_CONFIG`).
  Pure `assemblePrompt(config, ctx)` (`shared/prompt-assemble.ts`) renders sections before the
  boundary → **static (cached) system prompt**, after → **dynamic (per-turn, cache-safe)**, wired
  into `runChatTurn`'s `systemPrompt`. **World Info** is native: `always` scope → static, `keyword`
  scope (basic whole-word match over recent messages) → dynamic. **Persona pin done right** (not a
  jank addon): `{{user}}` resolves to the PINNED persona in card-derived sections (no retroactive
  rewrite) and the ACTIVE persona in user-authored sections — dual-resolution baked in. Assembly
  emits a metadata **trace** (section ids, WI included, matched keys) logged at debug for
  visibility. Built on the empty preset triad — NO migration (the blob already held it). ·
  **Greetings fold ✅ (migration 0009):** `character_versions.greetings[]` ([0]=first_mes, rest=alternates;
  importer folds + corpus re-imported, all retained). ·
  **Phase 5 raw mode 5A/5B ✅:** built on **`@openrouter/sdk` + the Responses API** (NOT the openai
  package — removed; NOT card-curator). **5A** live `/models` catalog (`domain/models` → `rawModels` tRPC);
  **5B** `runRawTurn` (assembled system→`instructions`, canon→`input`, typed errors→our kinds, same
  `ChatTurnResult`) — both live-validated; `dotenv` loads the real `.env` key. ·
  **Phase 5 mode routing 5C ✅ (centralized model selection):** `chats.model` (migration 0010, mode-agnostic
  next-turn model; `messages.model` stays provenance) + `DEFAULT_RAW_MODEL_ID` (`openrouter/auto`).
  **`resolveTurnRouting(chat, config)`** (`domain/chat/routing.ts`) is the SINGLE owner of
  `{provider, model, params, providerRouting?}` — `send()` names no model / hardcodes no provider, it calls
  the resolver and branches the runner (`sdk`→`runChatTurn`, `raw`→`runRawTurn` over canon, no session_entries);
  provider-agnostic persist (`provider`=routing, `sessionId` sdk-only); fails loud on an incoherent/unimplemented
  mode+provider combo. `runRawTurn` gained `providerRouting`→ Responses `provider` (from `chats.metadata`).
  Model validity is checked at SELECTION time (the picker), not the send path. Verified: 92 tests green; 0010
  applied to the real corpus DB (801 chats, FK-clean). ·
  **Phase 5 conversion+fork 5D ✅:** `convertToRaw` (one-way sdk→raw in place: mode/provider, model→null,
  sessionId→null, convertedAt; chat-locked) + `forkChat(atSeq, targetMode)` (new chat, parentChatId/forkedAt,
  copies canon seq≤atSeq + the characterVersion PIN/persona/preset/model + chat WI; raw-target rebuilds from
  canon, source intact). tRPC `chat.convertToRaw`/`chat.fork`; `ChatOperationError`→NOT_IMPLEMENTED|BAD_REQUEST.
  raw→sdk fork throws a loud `fork_sdk_unsupported` — DEFERRED to the shared canon→session_entries seeding
  primitive (folded into greeting seeding). 96 tests green. ·
  **Phase 5 seeding + greeting (#39) ✅:** `domain/chat/seed.ts` `buildSeedFrames` synthesizes resumable SDK
  frames from canon — shape EMPIRICALLY validated (`scripts/seed-probe.ts`, Haiku+Sonnet: bare frames rejected,
  per-frame metadata load-bearing, sessionId must be uuidv4). Wired into raw→sdk fork (seeds + sessionId) +
  greeting seeding (greetings[0] → message row #1 + sdk session via the ST invisible-user prefix) + a
  `generateOpeningIfEmpty` toggle (model writes the opening; off by default). See `docs/sdk-notes.md`. ·
  **Phase 5 swipes + edits 5E ✅ (backend, curl-verified):** `swipe` (regen last assistant → new `message_variant` +
  `activeVariantIdx`; first swipe migrates original→idx0; greeting swipe via OPEN_SCENE; mutates the tip, doesn't
  advance seq), `selectVariant` (repoint, no model call), `editMessage` (in place, no model call). sdk session sync
  via `reseedSdkSession` (re-seed from canon, rotate sessionId, drop old frames — the validated re-seed model);
  raw rebuilds from canon. `MessageView` += `activeVariantIdx`/`variantCount`. Verified live over the curl harness
  (`scripts/swipe-edit-probe.sh`). · **sdk-mode generation defaults wired** in `buildClaudeSdkEnv` (thinking OFF,
  Opus capped 200k, ambient `CLAUDE_EFFORT` neutralized — verified via `scripts/env-knob-probe.ts`). ·
  **⚠️ ACTIVE RE-ARCHITECTURE (decided May 2026, owner-approved, NOT built — supersedes "raw = @openrouter/sdk
  Responses" below): 4 PROVIDER MODES.** (1) **Claude Sub** = Agent SDK + `claude login` (Max sub, free) [built];
  (2) **Claude API** = the SAME Agent SDK runner env-swapped to **OpenRouter's Anthropic skin**
  (`ANTHROPIC_BASE_URL=https://openrouter.ai/api` + `ANTHROPIC_AUTH_TOKEN=<OPENROUTER_API_KEY>` + `ANTHROPIC_API_KEY=""`)
  → paid Claude via OpenRouter, REUSES the whole pipeline (caching/thinking/events/seeding/swipes), only the env
  differs; (3) **OpenRouter Chat Completions** = `@openrouter/sdk` `chat.send` + per-block `cache_control` (non-Claude);
  (4) **OpenRouter Responses** = `@openrouter/sdk` `beta.responses.send` (current `runRawTurn`; OpenAI). **NEXT STEP:
  run `pnpm exec tsx scripts/claude-or-probe.ts`** (validates mode 2 — does the Agent SDK run via OpenRouter's skin?
  not yet run). Then: `buildClaudeSdkEnv` OpenRouter variant + 3-way `resolveTurnRouting` + send/swipe branch.
  Full plan + verified findings in [[project-neo-tavern-4modes]] memory + `docs/sdk-notes.md`. ·
  **Phase 5 remaining — see `docs/build-plan.md`:** the 4-mode build (above) · chat UX (the surface rendering
  swipes/edits/branch) · `{{memory}}` retrieval · managed compaction · streaming/SSE · preset CRUD+editor ·
  error-variant UI. (Deferred: alternate greetings → `message_variants` on import.) ·
  **Phase 6** analytics (one chart at a time, only when there's a real question).

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
- **`docs/handoff-relational-fixes.md`** — spec for the FK + preset-versioning migration (✅ landed as 0007).
- **`docs/observability.md`** — pino logging + the `curl`-able `/api/_debug/*` API.
- **`docs/sdk-notes.md`** — provider SDK map: Agent SDK (sdk-mode, `pnpm sdk:play`/`sdk:compaction`,
  the event matrix, compaction, prompt assembly) + OpenRouter (raw mode — `@openrouter/sdk` + Responses API).
- **`docs/dependencies.md`** — deps (installed + deferred parking lot).
- **`references/README.md`** — reference repos (read, don't copy): external clones
  (astra-projecta/marinara-engine/sillytavern) **+ symlinks to our sibling repos
  `card-curator`/`st-bridge`** (the corpus/RAG answer-keys, in `development/`).
- **`README.md` / `ONBOARDING.md`** — how to run / human-teammate onboarding.

**Dev tools (don't reinvent — drive these):** `pnpm sdk:play` (Agent SDK probes — env/models/
latency; `DISCOVER=<term>` greps the real `claude` binary for env knobs), `pnpm sdk:compaction`
(compaction + session-seeding probe — the measured frame/turn/knob shapes live in `docs/sdk-notes.md`),
`pnpm embed:probe` (live BGE-M3), `pnpm import:st` / `pnpm embed:corpus[:gpu]` (corpus),
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
- Internal links are now **enforced FKs** (migration 0007 — cascade policy in `docs/data-model.md`); polymorphic refs (`embeddings`/`taggables` entity refs) stay plain `text` by necessity.
- **Raw mode = `@openrouter/sdk` + the Responses API** (`beta.responses.send`) — NOT the `openai`
  package (removed), NOT card-curator (local-llama). `instructions`=system, `input`=conversation;
  typed errors → our kinds by `statusCode`. The shell `OPENROUTER_API_KEY` was a REVOKED key (401
  "User not found"); the valid key lives in `.env` (gitignored), loaded via `dotenv override:true`.
  Working reference: `/home/inktomi/discovery/scaffold/index.ts`. (docs/sdk-notes.md, build-plan.md)
- **Prompt structure lives in the preset `config` blob** (`PromptConfig`, `shared/prompt-config.ts`) —
  reorderable sections + a cache `boundary`, NOT normalized rows (a version must be an immutable
  snapshot). `assemblePrompt` (`shared/prompt-assemble.ts`) → static/dynamic system halves. (data-model.md)

When unclear, ask. Don't re-litigate locked decisions — raise a question if you disagree.
