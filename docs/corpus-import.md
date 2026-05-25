# Corpus import & RAG — the answer key (card-curator + st-bridge)

We are **not** the first to parse this corpus. Two of our own projects already solved
it, validated against the real **~310-card / 124-chat-dir** SillyTavern corpus. **Port
their logic; do not re-derive.** Both are local git repos — cite, lift, adapt to TS.

- **card-curator** (`development/card-curator`, Python) — the deep source: PNG card
  extraction, ST chat parsing, semantic indexing (embeddings + CSLS hubness + rerank).
- **st-bridge** (`development/st-bridge`) — a *live bridge* to a running ST (eval/command
  transport), architecturally the opposite of us, so its 1.7k-LOC `server.py` mostly
  doesn't apply. Two assets do: (1) `src/st_bridge/dates.py` — card-curator's date logic,
  lifted **and improved** (numeric-string epochs · `is_branch` via `"Branch #"` substring,
  not `startsWith`, which recovers ~80 branches · filename-derived parent) — all three
  folded into our chat parser. (2) `src/st_bridge/embeddings.py` — a **second, in-process
  CSLS implementation** (nomic-embed via SentenceTransformer, numpy `_compute_hub_scores`/
  `_csls_correct`), closer to our no-GPU constraints than card-curator's GPU/ChromaDB
  stack → a Phase 4.6 cross-reference (see CSLS bullet below).

The parsers + retrieval *scaffolding* port 1:1. The GPU / 8B-model / ChromaDB / MCP
stack does **not** (and shouldn't) — see the model-divergence note below.

## Importer (Phase 4) — port to TS

| artifact | source `file:line` | what / why |
|---|---|---|
| PNG `tEXt` reader | `card-curator/src/card_curator/extract.py:386-407` | hand-rolled chunk walker, `ccv3`→`chara` precedence (`:441`). Port verbatim — no PNG lib needed for read. |
| Card format normalize | `extract.py:340-383` | V1 / V2 / V3 / Pygmalion-Gradio detection order. **Highest-value parser** — without it ~5–15% of a real corpus fails to import silently. |
| Card fields + lorebook | `extract.py:459-489` | `character_book.entries` is **dict OR list**; keep `enabled`; strip the literal `"Creator's notes go here."` placeholder. |
| Chat JSONL parse | `card-curator/.../chats.py:376-484` | line 0 = header (`user_name`, `character_name`, `create_date`, `chat_metadata`); lines 2+ = messages. Resilient per-line parse (skip corrupt lines, `utf-8`/`errors=replace`). |
| Date parsing | `chats.py:47-118` / already in `st-bridge/dates.py` | 4 formats: ISO 8601, epoch-ms (`>1e12`), ST `@14h56m48s[989ms]`, human `"August 27, 2025 6:36pm"`. |
| Branch / fork tree | `chats.py:361-373, 615-701` | branch = filename starts `"Branch"`; parent = `chat_metadata.main_chat` (normalize `+.jsonl`); reconstruct tree → `chats.parentChatId` + `forkedAt`. |
| Swipe → variant | `chats.py:464-483` | `swipes[]` + per-swipe `swipe_info[].extra.model` (each regen can use a different model). → `message_variants` child table (see `data-model.md`). |
| Four-bucket chat filter | `card-curator/scripts/check_chat_filters.py:17-82` | `header_only` / `all_empty_msgs` / `greeting_only` (no `is_user` message) / `real_conversation`. **Import all to `messages`; skip greeting-only + empty from the RAG index and analytics.** |
| Content-hash dedup | `chat_index.py:239-246` | SHA-256 of file bytes, **not mtime** (`docker cp` rewrites mtimes → full re-index every sync). Feeds `characters.importHash` + re-import idempotency. |

**Gotchas from real ST data** (all in card-curator):
- `gen_started` / `gen_finished` are **top-level**, not under `extra` (`chats.py:316`).
- `character_name: "unused"` header → fall back to the directory name (`chats.py:395`).
- Oversized single messages (code dumps, 22K-token monsters) — truncate per-message
  before segmenting (`chat_index.py:111`).
- Coding-assistant chats are excluded entirely (`config.py:122` `CHAT_EXCLUDE_DIRS`).

**Where our design already wins:** card-curator keeps a hand-maintained
`CHARACTER_DIR_ALIASES` map (`config.py:127`) because it keys everything by **filename**,
so renamed/replaced cards orphan their chats. neo-tavern keys by **stable
`characters.id`**, so this is just an *import-time mapping input* ("these dirs are one
character"), never a schema column. Same for the PNG-as-truth problem — we parse the
card into rows on import (`raw` json preserved), the PNG is transport.

## RAG / analytics (Phase 3/6) — re-implement on BGE-M3 + libSQL

Algorithms are model-agnostic and port unchanged; only the embedding model differs.

- **CSLS hubness correction — ✅ IMPLEMENTED (Phase 4.6.3a).** `embeddings.hub_score`
  (migration 0005) + `src/server/domain/corpus/hubness.ts` (`computeHubScores`, run via
  `pnpm csls`) + the query-time re-rank in `src/server/domain/search/service.ts`. Computed
  **per (entity_type, model)** — char hubs (avg 0.71) and segment hubs (avg 0.86) have
  different distributions, so a mixed score skews both. Ported from `index.py:62-89` +
  `server.py:157-175`. `hub_score` = mean cosine-sim of a vector to its K=10 nearest
  neighbours, precomputed at index time (`embs @ embs.T`), stored per row; at query time
  `adjusted_dist = max(0, dist − 1 + hub_score)`. **The highest-value lift — BGE-M3 has
  hubs too.** This is the good-vs-mediocre line for semantic search over a few-hundred-item
  corpus.
  **Second reference:** `st-bridge/src/st_bridge/embeddings.py:149-177`
  (`_compute_hub_scores` K=10 · `_csls_correct` penalizing above-mean hubness) — the same
  math in plain numpy, in-process. Our libSQL twist: precompute `hub_score` per embedding
  row at index time and fold it into the re-rank after `vector_top_k`, rather than holding
  the full `embs @ embs.T` matrix in memory.
- **Chat segmentation** — `chat_index.py:48-215`: 4096-token target / 512 min / 50%
  overlap, **never split a user→char exchange** (snap to pair boundary), per-message
  binary-search truncation, single-segment fast path. Embeddable text template at `:226`.
- **Hybrid query** — `server.py:107-135`: embed the query instruction-prefixed **and**
  raw, fuse by keeping the min distance per id; documents embedded raw.
- **Degenerate filter** — `config.py:76`: `MIN_SEARCH_TEXT_TOKENS = 150` (tiny-text cards
  match everything moderately; filter from results, still directly retrievable).
- **Field budgeting + order** — `extract.py:143-186`: core fields first (last-token
  pooling weights later text more), optional fields appended only under budget.
- **Two-stage retrieve→rerank** — `server.py:189-222`: over-fetch `n*3` via CSLS, rerank
  to `n`. Keep the *shape*; swap the local 8B reranker for an API cross-encoder, or skip
  reranking initially.
- **find-duplicates / similar** — `server.py:663, 926-987`: self vector-top-K at cosine
  ≥ 0.92 → a libSQL `vector_top_k` self-join.
- **`discover`** — `server.py:229+`: search chat segments → group by character → enrich
  with card metadata = "who have I actually done X with." **This is the killer feature.**

## The model divergence (validated, deliberate)

| | card-curator | neo-tavern |
|---|---|---|
| embed model | Qwen3-VL-Embedding-8B | **BGE-M3** (1024-dim, 8192 ctx) — LOCKED |
| reranker | Qwen3-VL-Reranker-8B | **bge-reranker-v2-m3** (Xenova ONNX cross-encoder) — LOCKED |
| dim | 4096 | 1024 |
| host | local GPU (A6000, 48GB) | **in-process onnxruntime-node CUDA** (A6000) |
| CUDA runtime | system | **uv-vendored CUDA-12 + cuDNN-9** (`tools/cuda/`, `pnpm cuda:setup`) |
| GPU layout | embedder + reranker split across 2 cards | same — embedder GPU 0, reranker GPU 1 (`CUDA_VISIBLE_DEVICES`) |
| store | ChromaDB, 4 collections | libSQL native `F32_BLOB(1024)` + `libsql_vector_idx` |
| modalities | card **text + images** | text only |

**LOCKED (May 2026, supersedes the original "no GPU" call):** we DO use the GPUs — BGE-M3 +
bge-reranker-v2-m3 run **in-process** via onnxruntime-node's CUDA EP (proven: ~24× over CPU,
fully on-GPU bar 8 trivial input-prep ops). The CUDA-12 runtime is vendored project-locally
with uv (`tools/cuda/`), not a system install. fp16 on the Ampere cards (~30% faster). The
embedder is **device/dtype-configurable** (`EMBED_DEVICE`/`EMBED_DTYPE`); CPU stays the
default for tests/queries (short, ~0.04s — same model, so cpu-fp32 queries share the space
with the cuda-fp16 corpus). Swapping models later is cheap — `embeddings.model` tags every
vector — so this isn't a marriage; a Qwen3-Embedding upgrade is a spike + re-index away.
**Image embeddings (visual card similarity) are DEFERRED, not given up** — verified feasible in
our stack: CLIP (`Xenova/clip-vit-base-patch32`, 512-dim) embeds a card PNG in-process via the same
transformers.js + `.models` + CUDA setup. Add when wanted = a CLIP model + a second `F32_BLOB(512)`
table/column + its own `libsql_vector_idx` (separate dim from the 1024-dim text vectors), mirroring
card-curator's `card_images` collection. The libSQL store is vector-agnostic.

**Vector-store capabilities (verified — supersedes any earlier "can't upsert/delete" claim):**
`libsql_vector_idx` does full CRUD — `UPSERT`/`UPDATE`/targeted `DELETE WHERE` all work and the index
auto-maintains. The only footgun: bulk `DELETE FROM` (emptying a vector table) poisons the shadow
index → next insert fails; fix with `REINDEX <idx>`. So **incremental re-embed = targeted DELETE +
re-INSERT** (just like card-curator's ChromaDB delete-and-readd). See `docs/conventions.md`.

**Card embed text** = card-curator `EMBED_FIELDS` (`config.py:63`): name, tags, description,
personality, scenario, first_mes (+ optional alternate_greetings); **excludes** mes_example /
system_prompt / post_history / creator_notes (instructions/meta, dilute identity signal).
**Token counting uses the real BGE-M3 tokenizer** (not a chars/4 estimate) — for segmentation
budgets, the embed cap, the MIN_SEARCH_TEXT_TOKENS=150 degenerate filter, and **token-budget
batching** (cap total padded tokens/batch, not a fixed count — `config.py:97`).

## Per-chat stats menu (Phase 6, when a chart asks a real question)

`card-curator/.../chats.py:165-197` (`ChatFile.to_metadata`) is a ready-made column list:
message/word/token counts, swipe count, first/last dates, `models_used` / `apis_used`,
reasoning + time-to-first-token + gen-time aggregates. **Don't add columns
speculatively** (slop guard) — `chats.metadata` JSON holds extras until a real question
needs a real column.
