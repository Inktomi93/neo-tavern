# Build plan

## Principle: bottom-up, de-risk first, pivot cheap

Build the foundation before the features that sit on it (**db → domain →
transport → client**), and validate the load-bearing tech bets with **throwaway
spikes before pouring concrete**. A wrong assumption should cost a 20-minute
spike, not a rebuild. If a vertical slice reveals the layer cake is wrong, you
find out with ~3 files written, not 30.

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

1. **`db`** — schema from `data-model.md` + libSQL client + migrations + the
   in-memory test harness (`tests/AGENTS.md`). _Re-add: `@libsql/client`,
   `drizzle-orm`, `-D drizzle-kit`._
2. **`domain/chat`** — the YGWYG turn (resume-based, proven in Step 0). The
   **walking skeleton**: the cheapest full proof of `db → domain → trpc → client`.
3. **`trpc/routers/chats` → `client/features/chat` → the `/chats/$id` route** —
   first real UI, built last in the slice.
4. **The product:** `domain/corpus` + `embeddings` (_re-add
   `@huggingface/transformers`_) + `domain/search` → `features/corpus-search`.
5. **Importer** (`jobs`) — walk the ST corpus → our schema. SillyTavern is cloned
   in `references/` for the exact card / world-info / JSONL formats.
6. **Analytics** — `domain` queries + `features` charts (`recharts`), one chart at
   a time, only when there's a real question.

## Why chat before the corpus (which is the product)

Chat is the **cheapest end-to-end slice** — it proves the full stack with less
complexity than RAG/search, so the architecture gets exercised early and cheaply.
The corpus product (the actual goal) then builds on rails that already carry
weight, and its tech is already de-risked by Step 0. If you'd rather build the
corpus slice first, the spikes cover it either way.
