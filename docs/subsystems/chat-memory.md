# Memory system — the chat `{{memory}}` spec (refinement plan, now SHIPPED)

**This supersedes the original design doc.** It records what we **built**, what we **measured on the
real corpus**, and the **refinements + migrations** that turned it into something usable. It is the
authoritative spec; read alongside `src/server/domain/chat/memory/` (the code:
`generate.ts`/`retrieve.ts`/`constants.ts`/`db.ts`), `docs/architecture/data-model.md`,
`docs/subsystems/chat-memory-diagram.md` (the visual companion), and `docs/subsystems/sdk-notes.md`.

> **STATUS — the plan below has SHIPPED (verify against `memory/constants.ts` `DEFAULTS`).** This doc
> reads as a forward plan (§6 migration, §8 steps, §9 knobs), but those landed:
> - **§6 — legacy `embeddings` → `character_embeddings`**: DONE. The owner-columned `character_embeddings`
>   table exists (`db/schema/search.ts`) and the old polymorphic `embeddings` table is retired.
> - **§8/§9 — write/read-path refinements**: DONE. `DEFAULTS` are `blockSize 8`, `verbatimWindow 8`,
>   `queryWindow 2`, **`mode: "mixC"`** (flat query-driven RAG is the default), `fanOut 4`, `maxTier 3`,
>   `rerankTo 3`, `minScore 0.25`, `keywordMatch` with the ≥4-char word-overlap fix (the multi-word
>   keyword bug, §7 #4). Segments cover the trailing partial / whole short chat (`generateSegments`).
> - **One divergence from §9:** `retrieveK` shipped at **8**, NOT the proposed 4 (constants.ts note:
>   "top-4 too tight on long chats; rerank cost negligible"). The §9 table below still says 4 — treat 8 as current.
>
> The sections below remain the authoritative *rationale* (the why behind each knob + the measured
> corpus data). Read them as "why it is this way," not "what to do next."

---

## 1. The principle (retained, unchanged)

> **Canon is truth; memory is a derived, regenerable index over canon.** Every digest, fact, keyword,
> and embedding is a pure function of the append-only `messages` table and can be rebuilt at any time.

Two facts justify the whole system:
1. **We keep ALL messages forever** — including those aged out of the model's context window.
2. **The model loses *visibility* to that aged-out canon.** Memory is the high-signal, regenerable
   index that reaches back past the live window and re-surfaces the relevant parts.

No SillyTavern memory extension can rebuild like this — they summarize as they go over JSONL, with no
durable canon. We have the whole conversation in SQL, so a bad digest is *fixed*, not lived with.

---

## 2. What we measured (the corpus — this grounds every number below)

Rough tokens at ~4 chars/token, over **782 chats with messages / 20,845 messages**:

| Metric | median | p90 |
|---|---|---|
| tokens / assistant message | 550 | 1,056 |
| tokens / user message | 139 | 304 |
| **tokens / chat (total)** | **9,076** | **29,194** (max 85,545) |
| tier-0 digest | 352 | 428 |
| card (static prompt) | 1,158 | 2,008 |

**Embedder limit (verified, not estimated):** BGE-M3 `model_max_length = 8192` tokens
(`max_position_embeddings: 8194` = 8192 + 2 specials). Measured with the **native Rust tokenizer**
(`@anush008/tokenizers`, `createBgeTokenizer`) — *real* BGE tokens, not chars/4 — per complete block:

| Block | median | p90 | p95 | **% over 8192 (truncated at embed)** |
|---|---|---|---|---|
| **16-msg** | 6,752 | 9,454 | 10,155 | **24.2%** |
| **8-msg** | 3,287 | 4,964 | 5,712 | **1.6%** |

Plus **48 single messages exceed 8192 on their own** — so block size alone can't guarantee a fit; the
embed *input* must be capped at the model max regardless (the full verbatim text is still stored for
rerank/click-through). `blockSize 8` is what cuts routine truncation from ~a quarter of segments to ~1.6%.

**Two findings reframe the design:**

1. **The context windows are 32k (OpenRouter modes) and 200k (agent-sdk).** The longest chat (85k) fits
   whole in 200k → on agent-sdk, memory injection essentially never triggers. **Memory injection is a
   32k-mode feature.** The *build* (digests/segments/embeddings, for corpus search) is window-independent.

2. **Corpus coverage is a hole.** Segments require one *complete* block, so:

   | | chats searchable | invisible |
   |---|---|---|
   | block=16, complete-only (**shipped**) | 419/782 (54%) | **363** |
   | block=8, complete-only | 519/782 (66%) | 263 |
   | **block=8 + embed partial/short** | **782/782 (100%)** | **0** |

   The 263 still-invisible chats are the 1–7-message ones — substantial content (beefy messages), not
   junk. Only **embedding the trailing partial / whole short chat** closes the hole.

---

## 3. The retrieval model — flat query-driven RAG (modeled on ST's native Vector Storage)

We modeled the original `{{memory}}` on ST's native vectors and then over-elaborated it. The correct,
proven model is **flat RAG**, exactly as ST does it:

> Every turn: **query = last `queryWindow` (2) messages** → embed → **retrieve top-K relevant tier-0
> digests** above `minScore` → **inject** them. That's it. No "inject the whole story," no tiered
> bridge, no per-turn token-budget juggling.

ST's reference defaults (`public/scripts/extensions/vectors`): `query: 2`, `insert: 3`,
`score_threshold: 0.25`, `protect: 5` (exclude the last 5 messages from results — they're in context).

### Our mapping (we already implement this — it's `mixC`)
- **Query** = `recentQueryText` = last 2 messages → `embedder.embed`.
- **Retrieve** = exact in-process cosine over **this chat's tier-0 digests** (never the global ANN),
  filter `≥ minScore`, plus a keyword-overlap path → top `retrieveK`.
- **Rerank** (`mixC`) = cross-encoder → top `rerankTo`.
- **Inject** = the chosen digests fill the **`{{memory}}` marker in the dynamic (cache-safe) system
  prompt half** — *not* a message-depth insert. This is a deliberate divergence from ST's `depth`;
  it's already wired (`assemblePrompt`), so **no injection rewrite is needed**.
- **`protect`** = our **`verbatimWindow`**: digests only cover *aged-out* blocks (below the window), so
  recent messages are never surfaced as memories. The "don't re-inject what's in context" guard is
  baked into generation eligibility — `verbatimWindow` is the protect-zone, **not a budget knob**.

### What this kills
- **The window-budget panic.** Injection is ~`rerankTo` digests ≈ **~1k tokens**, identical on 24k /
  32k / 200k. The context window constrains **raw history** (compaction's job: agent-sdk native /
  openrouter `compactedAtSeq`), not memory.
- **"Mix A → D as the chat grows."** There is no transition — every turn is flat top-K RAG. `mixA`
  (all tier-0) and `tiered` (the bridge) survive as **opt-in "give me the arc" modes**, not the default.

---

## 4. The unit — structured digest (retained) + the summarizer

Our one real upgrade over ST (which retrieves raw 400-char chunks): the retrievable unit is a
**structured digest** of a block, which embeds with cleaner signal.

| Field | What |
|---|---|
| **Topic anchor** | mandatory first line `[entities — scene]` — the dominant retrieval discriminator |
| **Significance-filtered facts** | durable state changes / reveals / decisions — the "brought up unprompted later?" litmus, not play-by-play |
| **Concrete keywords** | 15–30 scene-specific tokens (a whole-word/overlap retrieval path beside the vector) |
| **Provenance + FKs** | `chatId`, `ownerId`, `characterVersionId`, `tier`, `seqStart/seqEnd`, `blockIdx`, `model`, `summarizerModel`, `tokens`, `createdAt` |
| **Embedding** | BGE-M3 1024-dim, always populated (digests serve corpus search too) |

**Summarizer — three local models + hosted fallback, unchanged (no new sources):**
- **Local-first:** Qwen3-4B-Instruct GGUF via node-llama-cpp (`SUMMARIZER_GGUF`, opt-in, free, in-process).
- **Fallback:** hosted Claude Haiku over the existing `runChatCompletionTurn` (OpenRouter) when no GGUF
  is set / GPU busy.
- **Discipline (adopt from ST):** blunt, output-only, hard-capped prompt ("respond with nothing but the
  digest") so a small model doesn't role-play the summary. Skip **genuinely empty** blocks only — NOT a
  char threshold (our messages are substantial; don't drop real short content).

Embedder = **BGE-M3** (in-process ONNX/CUDA), reranker = **bge-reranker-v2-m3** (fp16, CUDA-only). All
three share the `WarmModel` warm/idle-unload lifecycle.

---

## 5. The corpus / build layer (window-independent)

The hybrid corpus search (`search.corpus`) is the killer differentiator and stays exactly as built —
**one reranked list over `chat_digests` (precise, anchored) + `chat_segments` (verbatim), deduped per
block, CSLS-adjusted, with `seq`-span click-through.** Refinements:

- **`blockSize 16 → 8`** (~3k tok/block): higher-fidelity digests (summarize 3k not 6k) and — critically
  — cuts BGE-8192 embed truncation from **24.2% → 1.6%** of segments (real-tokenizer measure, §2). Also
  gives +100 chats a complete block.
- **Cap every embed input at 8192 tokens** using the native Rust tokenizer (exact count, not chars/4):
  block=8 makes most blocks fit, but the residual 1.6% + the 48 oversized single messages must be
  truncated for the embedding (full verbatim text still stored on the segment row for rerank/click-through).
  The pipeline already truncates at the model max; we make it explicit + measured.
- **Segments cover the trailing partial block + whole short chats** → **54% → 100% coverage**. Digests
  keep the `verbatimWindow` protection (don't digest the churning tip); segments do not (corpus wants
  everything searchable; the tip just re-embeds on change).
- **Tiering / consolidation retained** (`fanOut`, `maxTier`) — powers the `tiered` mode and keeps very
  long chats' digest sets bounded; it is **not** the default injection path.
- **CSLS hubness retained** on all vector tables.

---

## 6. Migration: legacy polymorphic `embeddings` → owner-keyed `character_embeddings`

The polymorphic `embeddings` table is now **character-only** (Phase B retired `chat_segment`). It has
**no `ownerId`** — character search over-fetches the ANN pool and joins back to `characters.ownerId`
(`scopeToOwner`), which is less robust than a direct column under real multi-user load (the pool can be
dominated by other users → recall loss). The new memory tables avoid this with a denormalized `ownerId`
column. **This migration makes characters consistent and retires the legacy table.** (Resolves the
reviewer's multi-user note as a real fix, not a TODO.)

**Target — `character_embeddings`** (mirrors `chat_digests`/`chat_segments`):
- `id`, `characterId` → `characters.id` **cascade**, `characterVersionId` → `character_versions.id`,
  `ownerId` → `users.id` NOT NULL **indexed**, `model`, `embedding F32_BLOB(1024)`, `sourceText` (for
  the reranker), `hubScore`, `tokens`, `createdAt`; unique `(characterId, model)`; hand-added
  `libsql_vector_idx` ANN (`character_embeddings_ann`).

**Steps:**
1. Migration **0020**: create `character_embeddings` + ANN index.
2. **Re-embed the 309 current-version cards into it** (regenerable from canon — cleaner than copying
   rows; fast on GPU). `collectEmbedTargets` already builds the card text; point the embed pass at the
   new table and stamp `ownerId` (from `characters.ownerId`) + `characterVersionId`.
3. Repoint `knn` / `discover` / `corpus` character reads to `character_embeddings_ann` with a **direct
   `WHERE owner_id = ?`**; delete the character branch of `scopeToOwner` (the over-fetch hack).
4. Drop the polymorphic `embeddings` table (now empty/unused) and `entity_type`/`entity_id` plumbing.

**Outcome:** three consistent, owner-columned, FK'd, ANN-indexed vector tables —
`character_embeddings`, `chat_digests`, `chat_segments` — and the legacy polymorphic table is gone.

---

## 7. Reviewer findings → resolution

| # | Finding | Resolution |
|---|---|---|
| 1 | `fanOut`/`maxTier` unvalidated | set **4 / 3** (consolidation, retained); tiering is no longer the default-injection path so this is lower-stakes |
| 2+7 | Mix A→D transition / per-chat auto | **dissolved** — default is flat `mixC` RAG; `tiered`/`mixA` are opt-in |
| 3 | significance filter on a small model | keep Qwen GGUF + Haiku fallback; ST prompt discipline helps; spot-check Qwen vs Haiku on a combat-heavy chat (non-blocking) |
| 4 | **keyword match is a real bug** | multi-word keywords never match (`qWords.has(wholePhrase)`) → **fix to word-overlap** |
| 5 | cache-cost not visible | **populate `digest.tokens`** (never set today) + add cached/uncached split to the existing `previewAssembly` |
| 6 | legacy embeddings unkeyed | **§6 migration** (real fix) |
| 8 | fork starts cold | park — no chat frontend yet; note as a UI requirement ("memory warming up") |

---

## 8. Implementation plan (ordered)

**Step 0 — Curate the import.** Add a case-insensitive character-name skip-list to the importer
(`loader.ts` `collectBundlesFromDir`, the `bundles.push` seam): **exclude `Ruby` (93 chats — a
utility/assistant character, source of 85% of the >8192 single-message violations) and `Assistant`
(scratch, 15 chats).** Then delete the DB and re-import clean (purges the current rows; re-import is
cheap). ~108 chats / ~699 messages (14% of chats, 3% of content) drop out.

**Step 1 — Legacy → `character_embeddings` migration (§6).** Unifies the keying so all later corpus work
uses the consistent owner-columned table. Migration 0020 + re-embed cards + repoint reads + drop
`embeddings`.

**Step 2 — Write-path changes (must precede the re-backfill — they change what's stored):**
- `blockSize 8`; `generateSegments` embeds the trailing partial / whole short chat (100% coverage);
  **cap every embed input at 8192 BGE tokens via the native tokenizer** (store full text, embed a capped
  view); populate `digest.tokens` (+ segment tokens) at upsert; summarizer prompt discipline +
  empty-block skip; `fanOut 4` / `maxTier 3` (consolidation runs during backfill).

**Step 3 — Read-path changes (independent, anytime):**
- default `mode: mixC`; lift `queryWindow` to a knob (default 2); **fix the keyword-match bug**;
  `verbatimWindow 8`, `minScore 0.25`, `retrieveK 4`, `rerankTo 3`.

**Step 4 — Observability:** extend `previewAssembly` with `cachedPrefixTokens` vs `uncachedDynamicTokens`.

**Step 5 — One re-backfill:** `pnpm memory:backfill --all` at the new settings → 100% coverage + finer,
untruncated digests in one pass (~$0.30, regenerable).

**Step 6 — Docs/markers:** this file (done); park reviewer #8.

**Step 7 — Validation (non-blocking):** re-run real queries against the rebuilt corpus; Qwen-vs-Haiku
significance spot-check on a combat-heavy chat.

---

## 9. Parameters (shipped → refined, grounded in §2)

| Param | Shipped | **Refined** | Basis |
|---|---|---|---|
| `mode` (default) | `mixA` | **`mixC`** | flat query-driven RAG (ST) |
| `queryWindow` | hardcoded 2 | **2** (knob) | ST `query: 2` |
| `verbatimWindow` (= `protect`) | 30 | **8** | ST `protect: 5`; protect-zone, not a budget knob |
| `retrieveK` | 8 | **4** | over-fetch for rerank |
| `rerankTo` | 4 | **3** | ST `insert: 3` |
| `minScore` | 0.3 | **0.25** | ST `score_threshold` |
| `blockSize` | 16 (~6.3k tok) | **8** (~3k tok) | fidelity + embed truncation **24%→1.6%** (real-tokenizer, §2) + coverage |
| segment coverage | complete-only | **+ partial/short** | 54% → 100% |
| `fanOut` | 8 | **4** | earlier/actual consolidation |
| `maxTier` | 2 | **3** | tier-3 ≈ 512 msgs > 2× longest chat |
| summarizer | gguf → Haiku | **unchanged** | three models + fallback |

---

## 10. Retained / changed / deferred

- **Retained:** structured digests; tiering + consolidation (as `tiered` mode + long-chat bound); hybrid
  `search.corpus` (digests + segments, deduped, `seq`-linked); CSLS; the three-model + Haiku summarizer;
  `{{memory}}` injection in the dynamic system half; per-chat in-process cosine (never global ANN for
  within-chat).
- **Changed:** default retrieval = flat RAG (`mixC`); `verbatimWindow` is the small protect-zone;
  `blockSize 8`; 100% segment coverage; keyword-match fixed; character vectors re-keyed (§6); knobs
  re-derived (§9).
- **Deferred (substrate-ready, zero rework):** trackers (one in-place updating entry), clips (pinned
  one-offs), user-curated long-term promotion, per-chat summarizer profiles, fork "warming up" UI.

---

## 11. Adapted concepts + hard-won facts (keep — saves re-deriving)

- **CharMemory** → topic anchor (`[entities — scene]`, the precision step-change); significance litmus.
- **MemoryBooks** → LLM-extracted concrete keywords as a retrieval key (stored on the digest row, **not**
  as lorebook entries — we don't juggle world-info routing).
- **Summaryception** → vertical (consolidation-only) delta prompting; "ghosting ≈ canon-is-truth."
- **qvink** → manual per-digest edit (regenerable from canon); pre-summarization noise filtering.
- **ST native Vector Storage** → the retrieval model itself (§3): last-N-message query → top-K relevant →
  inject; `protect` for the recent zone.
- **Hard-won:** Qwen3.5's hybrid Gated-DeltaNet+SSM arch won't load on node-llama-cpp 3.18.1 → use
  non-hybrid **Qwen3**; disable thinking via `budgets.thoughtTokens:0` (not `/no_think`). Time is epoch-ms
  UTC everywhere. Never bulk `DELETE FROM` a vector-indexed table (poisons the ANN shadow index) — targeted
  deletes only. A model/backend swap = a full re-index (`model` tags the vector space).
- **BGE-M3 max = 8192 tokens** (verified `model_max_length`; `max_position_embeddings: 8194`). Anything
  longer is silently truncated at embed — measure with the **native Rust tokenizer** (`createBgeTokenizer`,
  `@anush008/tokenizers`), never chars/4, on any budget-critical or cap path. Real measure: 16-msg blocks
  truncate 24%, 8-msg 1.6%; 48 single messages exceed 8192 alone.
