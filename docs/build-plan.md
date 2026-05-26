# Build plan

## Principle: bottom-up, de-risk first, pivot cheap

Build the foundation before the features that sit on it (**db → domain →
transport → client**), and validate the load-bearing tech bets with **throwaway
spikes before pouring concrete**. A wrong assumption should cost a 20-minute
spike, not a rebuild. If a vertical slice reveals the layer cake is wrong, you
find out with ~3 files written, not 30.

## Principle: avoid rework — isolation contains churn, decide cross-cutting first

The architecture already stops per-feature churn: feature isolation is
`dependency-cruiser`-enforced (a new `domain/<feature>` literally *cannot* import
another, so building one can't force edits to another), schema growth is **additive
migrations** (never rewrites), and the router/context are **append-only seams** (a new
feature = one line + one service field). The walking skeleton's job was to set every
seam *once*; everything after copies the pattern as a **parallel slice**.

What the architecture does **not** protect: **cross-cutting concerns added after their
consumers exist** force edits across many files. So decide those *before* mass-producing
consumers. The only **wide** one is the **component system (shadcn)** — it gates *all*
UI including the corpus product, so it's set up before the product UI (Step 3.5). The
rest are **local** and safe to defer: streaming (chat-only), `message_variants`
(importer-only), markdown (one component). Rule: *foundations and cross-cutting choices
first; isolated features whenever.*

## Step 0 — de-risk spikes ✅ DONE (all passed, no pivots)

The three "this might not work the way we want" bets, validated with throwaway
probes (run, observed, deleted):

| Bet | Spike | Result |
| --- | --- | --- |
| **YGWYG sdk-mode chat** | Agent SDK: turn 1 → `resume` turn 2 → streaming | ✅ `resume` retained context across turns; streaming emits `stream_event`s. Use `query({ options: { resume: sessionId } })`; the escape-valve fork is `forkSession()`. |
| **Vector store** | libSQL native vectors via `@libsql/client` | ✅ `F32_BLOB` column + `libsql_vector_idx` ANN index + `vector_distance_cos` / `vector_top_k` all work. **No sqlite-vec extension needed** — schema updated (see `data-model.md`). |
| **Local embeddings** | `@huggingface/transformers` on this box | ✅ runs; small 384-dim model ~7 ms/embed, ~450 MB RSS. BGE-M3 (1024-dim) is heavier but the same mechanism. Allowlist the `onnxruntime-node` build (like esbuild) for native speed in Phase 3. |

## Current state

Rails + plumbing are done and verified (scaffold, both providers with confirmed
sub-auth, observability, the enforced layer cake). **The product layers are
empty** — 100% rails, 0% product.

## Build order — bottom-up, thin vertical slices

1. **`db`** ✅ — full 18-table schema from `data-model.md`, libSQL client (`createDb`
   + PRAGMAs incl. `foreign_keys=ON`, `runMigrations`), `0000_init` migration, and the
   in-memory test harness (`tests/support/db.ts` + a FK-enforcement smoke test). Deps
   added: `drizzle-orm`, `@libsql/client`, `nanoid`, `-D drizzle-kit`. (Native-vector
   `embeddings.embedding` column deferred → Step 4.)
2. **`domain/chat`** ✅ — the stateless YGWYG turn (resume-per-message): `DbSessionStore`
   over `session_entries`, optimistic `seq` guard + per-chat lock, injectable SDK runner.
   `auth` seam (`trust-header`) + `domain/_shared` (ids/lock/`ensureUser`). The
   **walking skeleton**: proved `db → domain → trpc → client` with a real model turn,
   driven + inspected via `/api/_debug`.
3. **`trpc/routers/chat` → `client/features/chat` → `/chats/$id`** ✅ — trpc rewired
   (services-in-context, so trpc never touches db/auth); `ChatView`/`MessageList`/
   `MessageInput`/`CreateChatForm` + home create-and-navigate; 4 domain integration
   tests (round-trip, stale-seq, resume, ownership). Deferred: greeting seeding, chat
   list, streaming, `message_variants` (raw mode), shadcn polish.
3.5. **Component system (shadcn)** ✅ — `@/` alias (tsconfig paths, no baseUrl + vite
   resolve), `cn()` util (`client/lib/utils.ts`), dark zinc theme tokens in
   `styles/globals.css`, `components.json` (so `shadcn add` works), base primitives
   `components/ui/{button,input,textarea}`; 4 chat components ported. Deps: clsx,
   tailwind-merge, class-variance-authority, @radix-ui/react-slot (lucide/tw-animate-css/
   sonner deferred until used). Add new primitives via `shadcn add <x>` (uses @/).
4. **The product.** **Phase 3a ✅ (foundation):** `embeddings` infra (BGE-M3 via
   `@huggingface/transformers`, CPU ONNX, `embedder.ts`), the `F32_BLOB(1024)` vector
   column + `libsql_vector_idx` ANN index (migration `0001`), `domain/corpus`
   (embed+store) + `domain/search` (`knn`: `vector_top_k` → exact cosine re-rank), +
   `search`/`corpus` trpc routers. Proven: deterministic vector test (`pnpm check`) +
   live `pnpm embed:probe` (dim 1024, related 0.659 > unrelated 0.382).
   **Remaining (post-importer, against the real corpus):** chat segmentation, CSLS
   hubness, hybrid query, two-stage rerank, the `discover` feature, owner-scoped
   results, and `features/corpus-search` (UI) — lift from card-curator per
   `docs/corpus-import.md`.
5. **Importer ✅ DONE** — `domain/import/` (peer feature, NOT `jobs/`: the
   `drivers-through-domain` rule bars `jobs/` from importing `db`, so the db-bootstrapping
   CLI is a composition root in `scripts/import-st.ts`). Pure parsers (`card.ts`/`chat.ts`,
   ported from card-curator + st-bridge), `loader.ts` (walk + hash + pair by `slugifyHandle`),
   `service.ts` (orchestration: copy-on-write versions, char-wide branch resolution,
   importHash idempotency). `pnpm import:st [dir]`. Validated on the real corpus: 309 chars ·
   801 chats · 20,845 msgs · 71,187 variants · 184 branches · zero dangling refs; re-run is
   idempotent. Schema additions: migration `0002` (`message_variants` + `messages.activeVariantIdx`),
   `0003` (`chats.importedFrom`/`importHash`).
6. **Search (Phase 4.6)** — the deferred Phase-3 product, now over the real corpus.
   **4.6.1 ✅** segmentation + identity-only card embed-text + embedding idempotency.
   **4.6.2 ✅ (code)** real native tokenizer (`@anush008/tokenizers` — JS tokenizer is
   quadratic), token-budget batching, owner-scoped knn, **in-process CUDA** embed pass
   (`pnpm embed:corpus:gpu`, project-local uv CUDA-12, fp16, GPU-saturated) — first full
   GPU index running. **4.6.3a ✅** CSLS hubness (per entity_type): `embeddings.hub_score`
   (migration 0005), `domain/corpus/hubness` precompute (`pnpm csls`, EXACT same-type top-K
   in-process — the ANN index was budget-exhausted by popular cards' own segments), query-time
   `adjusted_dist = max(0, dist−1+hub)` re-rank in `domain/search`. Validated on the real
   corpus (8225 vectors in 35s; char avg hub 0.72 vs segment 0.86 — why per-type).
   **4.6.3b ✅** two-stage cross-encoder rerank: `embeddings.source_text` (migration 0006,
   stored by the embed pass + `pnpm corpus:backfill-source-text` for old rows),
   `embeddings/reranker` (bge-reranker-v2-m3 ONNX fp16, max_length 1024, batched),
   `knn({rerank:true})` over-fetches the CSLS pool → cross-encoder → top-n; GPU-validated via
   `pnpm rerank:probe`. **4.6.3c ✅** the killer feature `discover` (`search.discover` — chat
   segments grouped by character, ranked by best matching conversation + snippet evidence +
   card meta; real-corpus validated via `pnpm discover:probe`). **4.6.3d ✅** `features/corpus-search`
   UI — `/corpus` route, two-mode (Discover | Find) box + rerank toggle; search state in the URL
   (shareable); `search.find` enriches knn hits with names/snippets. State = URL params + local
   form state + TanStack Query (no zustand needed). **The corpus product is end-to-end usable.**
   **Migration 0007 ✅ DONE** — `docs/handoff-relational-fixes.md`: internal FKs enforced
   (cascade policy) + presets → content-versioning (`preset_versions` triad) +
   `reasoningEffort` columns. Validated on the real corpus (foreign_key_check 0; importer
   idempotent under FKs); fixed a circular-FK bug in `domain/chat`. **Phase 4 is complete.**
7. **Phase 5 — chat-first frontend + mode escape valve** (CURRENT). The mission pivoted:
   chat is now co-equal with the corpus (a prettier SillyTavern). Foundations landed; the
   integration + UX remain.
   - **SDK-runtime hardening ✅** — `consumeTurnStream` classifies the full Agent SDK message
     union (compaction/retry/rate-limit/auth/errors) into `events[]` + a provider-agnostic
     `TurnError` (the shared contract, later extracted to `providers/turn.ts`); atomic send
     (rollback → `SendResult{status:"error"}`); migration 0008
     turn-metadata columns. Compaction measured empirically (`pnpm sdk:compaction`). See `sdk-notes.md`.
   - **Prompt assembly ✅ (keystone)** — `shared/prompt-config.ts` (`PromptConfig` Zod: reorderable
     sections + markers + cache `boundary`, lives in the preset `config` blob) + `shared/prompt-assemble.ts`
     (`assemblePrompt` → static/dynamic system halves) wired into `runChatTurn`. World Info `always`→static
     / `keyword`→dynamic; dual-persona pin ({{user}} pinned in card sections, active in user sections);
     debug trace. `character_versions.greetings[]` fold (migration 0009; re-imported the corpus).
   - **Raw mode 5A/5B ✅** — `@openrouter/sdk` + the **Responses API** (NOT the openai package).
     **5A**: live `/models` catalog (`listOpenRouterModels` → `domain/models` → `rawModels` tRPC). **5B**:
     `runRawTurn` (assembled system → `instructions`, canon history → `input`, typed errors → our kinds,
     same `ChatTurnResult`). Both live-validated. `dotenv` loads the real `.env` key. See `sdk-notes.md`.
   - **Mode routing 5C ✅** — **centralized model+provider selection.** `chats.model` (migration 0010,
     nullable, mode-agnostic — the chat's model for its NEXT turn; `messages.model` stays provenance) +
     `DEFAULT_RAW_MODEL_ID` (`openrouter/auto`) in `shared/models.ts`. **`resolveTurnRouting(chat, config)`**
     (`domain/chat/routing.ts`) is the SINGLE owner of `{provider, model, params, providerRouting?}` —
     `send()` names no model and hardcodes no provider, it calls the resolver and branches the runner:
     `sdk`→`runChatTurn` (sessionStore+resume), `raw`→`runRawTurn` (history from canon, no session_entries).
     Both injectable (fakes in tests); shared persist/rollback is provider-agnostic (`provider`=`routing.provider`,
     `sessionId` updated sdk-only). Resolver fails loud on an incoherent/unimplemented mode+provider combo
     (raw has two DESIGNED providers — openrouter + anthropic-direct; only openrouter built). `runRawTurn` gained
     optional `providerRouting` → the Responses `provider` field (sourced from `chats.metadata`; the "+ providers"
     half). Validation is at SELECTION time (the picker), not the send hot path. Verified: 92 tests green
     (7 resolver cases + raw round-trip + raw error-rollback); migration 0010 applied to the real corpus DB
     (801 chats intact, FK-clean).
   - **Conversion + fork 5D ✅ (the sdk→raw escape valve — the primary path)** — `convertToRaw(chatId)`:
     one-way sdk→raw in place (mode/provider, `model`=null so the Claude id doesn't 404 on OpenRouter →
     resolver default, `sessionId`=null, `convertedAt`; chat-locked; throws `not_sdk` otherwise). `forkChat(chatId,
     atSeq, targetMode)`: new chat (`parentChatId`/`forkedAt`) copying canon `messages` seq≤atSeq (new ids, seq
     preserved, token/cost metadata left null — not re-generated) + the shared `characterVersionId` PIN +
     `personaId`/`presetVersionId`/`model` (model resets on a mode switch) + chat-level WI attachments; raw-target
     rebuilds from canon, source untouched. tRPC `chat.convertToRaw`/`chat.fork`; `ChatOperationError` →
     NOT_IMPLEMENTED|BAD_REQUEST. "Canon is the only thing that crosses." raw→sdk fork now seeds via the
     #39 primitive (no longer throws). Validated.
   - **Seeding + greeting (#39) ✅** — see the deferred-backlog entry below; built the validated `buildSeedFrames`
     primitive + greeting seeding + the `generateOpeningIfEmpty` toggle, and wired raw→sdk fork onto it.
   - **Swipes + edits 5E ✅ (backend, curl-verified)** — `swipe(chatId, expectedSeq)` regenerates the last assistant
     turn as a new `message_variant` + `activeVariantIdx` (mutates the tip, does NOT advance seq; first swipe migrates
     the original to variant 0; greeting swipe uses the OPEN_SCENE path → alt greeting); `selectVariant` repoints
     (no model call); `editMessage` mutates content+editedAt (no model call). sdk session stays in sync via
     `reseedSdkSession` (re-seed from canon, rotate sessionId, drop old frames — the validated re-seed model, not
     frame surgery); raw rebuilds from canon. `MessageView` gained `activeVariantIdx`+`variantCount` (the n/m counter).
     109 tests green; **verified live over the curl/debug harness** (`scripts/swipe-edit-probe.sh`: create→send→swipe→
     select→edit, real sub turns, swipe produced a distinct variant, 0 errors). **DEFERRED:** alternate greetings →
     `message_variants` on import (the importer write side, separable); the swipe/edit UI (chat-surface work).
   - **Remaining:** chat UX (the surface that renders all the above), `{{memory}}` retrieval, managed compaction,
     streaming/SSE, preset CRUD+editor. See the deferred backlog.
8. **Analytics (Phase 6)** — `domain` queries + `features` charts (`recharts`), one chart at
   a time, only when there's a real question.

## Deferred backlog (consolidated — what's parked + where it belongs)

**Phase 4 (corpus) — deferred by choice, not blocked:**
- **find-similar / find-duplicates** — the optional standalone corpus feature (cosine ≥ 0.92
  `vector_top_k` self-join). `docs/corpus-import.md`.
- **CLIP image embeddings** (visual card similarity) — feasible, text-only for now. `docs/corpus-import.md`,
  `docs/conventions.md`.

**Phase 5 (chat) — beyond 5C/5D/5E above:**
- ✅ **Seeding primitive + greeting seeding (#39)** — `domain/chat/seed.ts` `buildSeedFrames(canon, sessionId)`
  synthesizes resumable SDK frames from plain canon; the shape is **empirically validated** (`scripts/seed-probe.ts`,
  Haiku + Sonnet — bare frames rejected; per-frame metadata is load-bearing; thinking/title/queue/last-prompt
  unnecessary). Wired into: **raw→sdk fork** (`forkChat(targetMode:'sdk')` now seeds + sets a uuid sessionId) and
  **greeting seeding** in `create()` (greetings[0] → messages row #1 + sdk session seeded via the ST invisible-user
  prefix). Plus the **`generateOpeningIfEmpty` toggle** (no greeting → the model writes the opening, a no-user-message
  turn; off by default = user speaks first; graceful fallback). See `docs/sdk-notes.md` "Seeding a session from canon".
  **Still deferred:** alternate greetings → `message_variants` (needs the 5E swipe machinery to switch between them).
- **`{{memory}}` retrieval marker** — RAG over chat history into the dynamic system prompt (reuses the
  embedding stack; embed chat-message chunks, knn scoped to this chat, inject above the boundary).
- **Managed compaction** — `DISABLE_AUTO_COMPACT=1` + watch `contextWindow` + a manual `/compact` with an
  RP-tuned prompt (SDK auto-compaction's "/tmp transcript" crutch is lossy for tool-less RP — measured).
  Alternatively/with it, an **owned-context `load()`** (curated transcript for long sdk-mode RP).
- **Streaming → UI** — forward token deltas (sdk `includePartialMessages` / Responses stream events) over
  an SSE tRPC subscription. The `onEvent` seam + the streaming events both exist; the consumer doesn't.
- **Live-push / multi-device sync** — SSE subscription + Query invalidation (today: reconcile-on-send). The
  stateless design enables it (`docs/data-model.md` concurrency section).
- **Preset CRUD + editor** — a copy-on-write preset domain service (mirror the importer's version forking)
  + the prompt-manager UI (drag-reorder sections, per-section toggles).
- **`chats.pinnedPersonaId`** — true persona-switch divergence (today the chat's single persona = both
  pinned + active; an additive column when persona-switching lands).
- **Granular raw-mode caching** — `cache_control` breakpoints (static cached, dynamic fresh) vs the current
  coarse `promptCacheKey` over the whole `instructions`.
- **Persisted `chat_events` table** — compaction/retry/rate-limit history (log ring + `events[]` suffice now).

**Cleanups (do alongside the above):**
- ✅ **`ClaudeTurnError` → `TurnError`** + extracted the shared contract to `providers/turn.ts` — the
  provider-agnostic turn contract (`TurnError`/`TurnErrorKind`/`TurnEvent`/`ChatTurnUsage`/`ChatTurnResult`/
  `RateLimitSnapshot`) now lives in `turn.ts`; both `claude-sdk.ts` and `openrouter.ts` import it, so OpenRouter
  no longer imports the Claude module or throws a Claude-named error. (sdk-specific `ChatTurnParams`/runtime
  stay in `claude-sdk.ts`; `RawTurnParams` in `openrouter.ts`.)
- **Error-variant UI** — the client only handles `status:"stale"`; the `status:"error"` send result (with
  `code`/`retryable`/`resetsAt`) has no UI yet. ~20-min win, independent of everything.

**Cross-cutting / infra deferred:**
- Chat UX polish: markdown render (`react-markdown`), avatars, message styling, chat list, swipe UI,
  context-fill meter (`contextWindow` is captured), virtualization (`@tanstack/react-virtual`).
- Editors: prompts/cards/world-entries (`@uiw/react-codemirror`). `zustand` (when genuine global state appears).
- **Docker/compose** (the deploy image into the authentik+caddy stack) · **Playwright E2E** (one happy-path
  per critical flow). Both deferred since Phase 1.

## Why chat before the corpus (which is the product)

Chat is the **cheapest end-to-end slice** — it proves the full stack with less
complexity than RAG/search, so the architecture gets exercised early and cheaply.
The corpus product (the actual goal) then builds on rails that already carry
weight, and its tech is already de-risked by Step 0. If you'd rather build the
corpus slice first, the spikes cover it either way.
