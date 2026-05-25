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
   (migration 0005), `domain/corpus/hubness` precompute (`pnpm csls`, per-row `vector_top_k`
   — no in-memory matrix), query-time `adjusted_dist = max(0, dist−1+hub)` re-rank in
   `domain/search`. Validated on the real corpus (8225 vectors; char avg hub 0.71 vs segment
   0.86 — why per-type). **4.6.3b ⏭** bge-reranker-v2-m3 two-stage (GPU 1) + store source_text,
   **4.6.3c** `discover`, **4.6.3d** `features/corpus-search` UI. Lift from card-curator +
   st-bridge per `docs/corpus-import.md`.
   **⏭ Migration 0006 (pending, specced)** — `docs/handoff-0006-relational-fixes.md`:
   enforce internal FKs (cascade policy) + presets → content-versioning. The importer
   added link columns + proved zero dangling; 0006 makes them DB-enforced FKs. (Renumbered
   from 0005 — that number is now hub_score.)
7. **Analytics** — `domain` queries + `features` charts (`recharts`), one chart at
   a time, only when there's a real question.

## Why chat before the corpus (which is the product)

Chat is the **cheapest end-to-end slice** — it proves the full stack with less
complexity than RAG/search, so the architecture gets exercised early and cheaply.
The corpus product (the actual goal) then builds on rails that already carry
weight, and its tech is already de-risked by Step 0. If you'd rather build the
corpus slice first, the spikes cover it either way.
