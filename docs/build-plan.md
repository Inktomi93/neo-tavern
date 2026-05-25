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

1. **`db`** ✅ — full 18-table schema from `data-model.md`, libSQL client (`createDb`
   + PRAGMAs incl. `foreign_keys=ON`, `runMigrations`), `0000_init` migration, and the
   in-memory test harness (`tests/support/db.ts` + a FK-enforcement smoke test). Deps
   added: `drizzle-orm`, `@libsql/client`, `nanoid`, `-D drizzle-kit`. (Native-vector
   `embeddings.embedding` column deferred → Step 4.)
2. **`domain/chat`** — the YGWYG turn (resume-based, proven in Step 0). The
   **walking skeleton**: the cheapest full proof of `db → domain → trpc → client`.
3. **`trpc/routers/chats` → `client/features/chat` → the `/chats/$id` route** —
   first real UI, built last in the slice.
4. **The product:** `domain/corpus` + `embeddings` (_re-add
   `@huggingface/transformers`_) + `domain/search` → `features/corpus-search`.
   - ⚠️ **Carried over from Phase 2:** add the `embeddings.embedding` `F32_BLOB(1024)`
     column + `CREATE INDEX … libsql_vector_idx(embedding)` via a migration HERE — the
     Phase-2 db foundation shipped the table's *scalar* columns only (deliberate defer;
     see `data-model.md` embeddings note). Verify the Drizzle `customType` insert
     (`vector32`, watch #3899) + query (`vector_top_k` / `vector_distance_cos`)
     end-to-end against a real BGE-M3 (1024-dim) embedding. Lift CSLS hubness +
     segmentation from card-curator (`docs/corpus-import.md`).
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
