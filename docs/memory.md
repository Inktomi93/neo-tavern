# Memory system — design + decisions

The within-chat `{{memory}}` system: per-N-turn **structured digests** of older conversation,
embedded and re-injected so a chat stays coherent past the point where it would normally degrade —
*and* so the model can see canon that has aged out of its context window entirely. Design is
validated by spikes + a working demo (`scripts/memory-demo.ts`) and by the community extensions we
adapt concepts from (see §10). The model **runtime is built** (the three local models in §6); the
digest *logic* isn't wired into the app yet (§11). Read alongside `docs/data-model.md`,
`docs/corpus-import.md`, `docs/sdk-notes.md`, and `src/server/domain/chat/memory.ts`.

---

## 1. The principle (lead with this)

> **Canon is truth; memory is a derived, regenerable index over canon.** Every digest, fact, keyword,
> and embedding is a pure function of the append-only `messages` table and can be rebuilt at any time.

Two facts make this the right frame, and together they are the whole justification for the system:

1. **We keep ALL messages forever** in SQLite — including every message that has aged out of the
   model's context window or been compacted away. The append-only log is canon; nothing is ever
   deleted to save context.
2. **The model loses *visibility* to that aged-out canon.** The Agent SDK compacts its own session;
   the openrouter runner rebuilds history only from `compactedAtSeq` forward. Once a message falls
   past the live window, the model can no longer *see* it — even though we still *have* it.

**Memory closes that gap.** It is the high-signal, regenerable index that reaches back into canon the
live context can no longer hold, and re-surfaces the relevant parts into the prompt. No SillyTavern
memory extension can claim this — they're bolted onto JSONL and summarize as they go, with no
durable canon to rebuild from. We have the entire conversation in SQL, so memory becomes a
rebuildable index: summarize retroactively, regenerate after an edit, re-embed after a model swap,
re-tier on demand. That property is what earns the design.

---

## 2. The problem (and why naive approaches fail)

- **Chats are short because they DEGRADE, not because memory is unneeded.** As context grows the
  model loses coherence and the owner restarts. Good memory should *extend* coherent chat length.
  (Corpus reality, queried 2026-05: 801 chats / 20,845 msgs; **median 17 msgs, p90 62, max ever
  222**; only 78 chats > 62 msgs, only 11 > 120. Longest = the "Bess" chat, 222 msgs ≈ 85.6k tokens.)
- **Raw-message vector recall is useless** — owner's own experiments *and* the 2026 consensus. RP
  prose is semantically diffuse; **raw conversation chunks all embed into the same mush** (everything
  is "high similarity," so cosine pulls vibe-matches, not fact-matches), and embeddings carry no
  narrative/temporal order. neo-tavern's *original* `{{memory}}` marker did exactly this — raw
  per-message chunks — and **never actually ran** (0 `chat_message` embeddings in the DB), so its
  premise was unvalidated. It is being **replaced** by structured digests.
- **The fix is STRUCTURE, not just summarization.** Every serious community extension summarizes
  before storing (qvink, MemoryBooks, Summaryception, CharMemory), and the ones that retrieve well do
  it by *structuring* the refined text so it embeds **distinctively** — topic anchors, extracted
  keywords, significance-filtered facts. CharMemory's own notes report that front-loading a topic
  anchor was a **step-change** in retrieval precision — larger than tuning the embedding model. The
  format itself is the signal. This is the core insight of the redesign (§3, §10).
- **"Summarize once at 80k" loses fine detail** — by then early context is already degraded.
  Summarize **incrementally per block while each block is still fresh**, regenerate per block rather
  than append/delete (consensus + recursive-summary paper arXiv 2308.15022).

---

## 3. The unit — a structured digest

The owner's hard requirements: **ONE system, not two; triggered per X turns, never arbitrary char
limits; and we are not juggling world-info/lorebooks** — we are already building a memory system, so
it owns its own retrieval. The unit is a single artifact — a **per-N-turn "digest"** — that is
deliberately *structured* so it retrieves with clean signal:

| Field | What | Adapted from |
|---|---|---|
| **Topic anchor** | mandatory first line: `[entities/names — specific scene label]`. The dominant retrieval discriminator — makes each block separable in embedding space where raw chunks are not. | CharMemory |
| **Significance-filtered facts** | durable **state changes**, decisions, reveals, relationship shifts — the "would this be brought up unprompted weeks later?" litmus — NOT play-by-play narration. | CharMemory |
| **Concrete keywords** | 15–30 specific, scene-specific tokens (locations, objects, proper nouns, unique actions); explicitly **not** abstract themes or character names. A whole-word match retrieval path complementing the vector. **Stored on the digest row, NOT as lorebook entries.** | MemoryBooks |
| **Provenance + FKs** | `chatId`, `characterVersionId`, `tier`, `seqStart`/`seqEnd`, `blockIdx`, `model`, `summarizerModel`, `createdAt`. The seq span links every digest back to its exact raw messages (verbatim click-through). | — |
| **Embedding** | BGE-M3 1024-dim, **always populated** (digests must be searchable — they serve corpus search too, §4). Memory's own retrieval can ignore it (Mix A), but every digest is embedded. | — |

**Independent at tier-0, hierarchical above it.** Each tier-0 block is summarized on its own (NO
horizontal delta-chain): a deep edit invalidates only its own block (§5) — robust to edits/forks. We
get the *signal* benefit that delta-chaining buys (non-redundant, distinctive text) from the
**internal structure** (anchor + significance filter), without the cross-block coupling that would
cascade-regenerate every later block on a mid-chat edit.

**Tiers are core, not deferred.** A good memory system *extends* coherent chat length (§2) — so chats
that work will grow past today's 222-msg max, and designing tier-0-only would design to a ceiling the
system exists to break. So we build hierarchical consolidation: when a tier accumulates `fanOut`
units, the oldest are consolidated into one tier-(k+1) digest. Consolidation is **where delta earns
its keep** (vertical, not horizontal): a tier-(k+1) digest is written context-aware against its
siblings, and the **first** consolidation into a new tier is a verbatim **seed promotion** (no LLM —
nothing is lost). Injection (§3 "mix") then becomes a **tiered bridge** — coarse high-tier digests for
the distant past + fine tier-0 for the recent — keeping the injected story-so-far at roughly constant
token budget *no matter how long the chat gets*. (Adapted from Summaryception, §10.)

### The "mix" spectrum (all one system — pick where you sit)
| Mix | What | Vectors? | When |
|---|---|---|---|
| **A. All digests, chronological** | inject every tier-0 digest in order = full "story so far" | none | short chats — the special case where only tier-0 exists |
| **B. Bridge + retrieved** | recent digests chronological + vector/keyword-pulled older | yes | when the digest list outgrows the budget |
| **C. + rerank** | cross-encoder sharpens the retrieved set | yes | when recall precision matters |
| **D. Tiered bridge (consolidation)** | coarse high-tier for the distant past + fine tier-0 for the recent; digest-of-digests via vertical delta + seed promotion | yes | **long chats — the mechanism that keeps "the whole story" within budget as length grows** |

**Default is Mix A → D as the chat grows.** Short chats have only tier-0 digests → Mix A (inject all,
~2–4k tokens, §9). As a chat lengthens, consolidation produces higher tiers and injection becomes the
tiered bridge (D) — roughly constant budget regardless of length. Vector + keyword + reranker (B/C)
remain the retrieval gear available at any tier. One system, retrieval and tiering as built-in levers.

---

## 4. Two scopes, one substrate

The structured digest is the high-signal substrate. It is *used* in two ways, each **explicitly
scoped** — this is how we honor "one refinement pipeline" without breaking the locked
within-chat/cross-chat separation:

1. **Memory (within-chat, in-character).** Inject *this chat's* digests (Mix A→D by tier; B/C as the
   gear). Retrieval is **exact in-process cosine scoped to `chatId`** — it ignores the global ANN. **A
   character NEVER remembers across chats** — each chat is its own isolated canon; cross-chat bleed
   breaks the fiction.
2. **Corpus search (cross-chat, user-facing) — built ALONGSIDE.** The same digest substrate, queried
   *globally* via its **ANN index**, with `chatId`/`characterVersionId` metadata and the topic
   anchors/keywords as discriminators, returning hits that **link back to the raw `seq` span** for the
   verbatim. A *user* search tool, not in-character injection — a different scope, never compared to
   memory injection. Built now, not staged: indexing is background work (relaxed timing for live
   chats; bulk for import), so there's no reason to defer it.

Same table, two read paths: memory does per-chat in-process cosine; corpus uses the ANN. **Raw
messages are always retained** as canon and verbatim click-through; a digest is an *index into* canon.
The raw verbatim layer is now its own first-class **`chat_segments` table** (block-bounded, live,
owner-scoped); the old import-only polymorphic `chat_segment` is **retired** (no longer produced or
read — `discover`/`knn`/`find` migrated, Phase B). `search.corpus` is the unified **"mix"**: ONE
reranked list over `chat_digests` (precise, topic-anchored) + `chat_segments` (verbatim), deduped per
block, source-tagged, with the seq span for click-through. Hybrid is the permanent end state — digests
don't replace segments; they complement them. **[BUILT — §11.]**

---

## 5. Mechanics / runtime model

**Dormancy — fresh chats do nothing.** Memory stays fully inert until at least one full block has
aged below the verbatim window (`maxSeq > verbatimWindow + blockSize`). A 3-message chat generates
zero digests and injects nothing. (Generalizes the old guard `history.length ≤ protect → null`.)

**Eligibility — the verbatim window is the seam buffer.** A block `[seqStart, seqEnd]` is digestible
only once it has aged fully below the live tail (`seqEnd ≤ maxSeq − verbatimWindow`). Swipes
(`createSwipe`: regenerate the tip as a new `message_variants` row — **never advances `seq`**) and
tip-edits only ever touch `maxSeq`, which is *inside* the window — so they can never corrupt a
digested block. The window absorbs all the live churn.

**Generation — one pipeline, two triggers, always off the critical path:**
- **Live (incremental):** after a turn completes, fire digest generation in the **background**
  (locked, fire-and-forget — mirrors the managed-compaction post-turn trigger in `send.ts`) for any
  block that just aged below the window. The heavy work (summarizer + embedder) never blocks the
  reply.
- **Backfill (bulk):** a one-shot pass per existing/imported chat (same pipeline, replayed
  start-to-finish). Imported chats and live chats run the *identical* generation code; only the
  trigger differs.

**Retrieval — cheap and synchronous:**
- **Mix A:** one SQL read of this chat's digests ordered by `seqStart` → inject. **Zero model
  inference on the critical path.**
- **Mix B/C:** embed the recent query messages (one short embed) → in-process cosine over this chat's
  ≤~dozen digests (+ optional keyword match) → optional cross-encoder rerank. Warm GPU → tens of ms.
  Exact in-process cosine scoped to one chat, **never the global ANN** (a single chat is small; the
  global pool would mix in other chats and hit its result ceiling — see `docs/conventions.md`).

**Invalidation — lazy, with a bounded vertical cascade.** A tier-0 digest is stale iff some message
in `[seqStart, seqEnd]` has `editedAt > digest.createdAt` (edits are in-place + `editedAt`;
`editMessage` does not truncate). On generation/retrieve, regenerate stale tier-0 blocks — and because
tier-0 is **independent**, only the touched block regenerates (no *horizontal* cascade). The one
cascade is **vertical**: a regenerated tier-0 block marks its tier-(k+1) parent stale (the consolidation
that covers its seq span), which regenerates and marks *its* parent — bounded to tree depth (log),
not chat length. Re-embed follows regeneration (corpus freshness). All deletes are **targeted** (by id
/ `chatId`), never bulk `DELETE FROM` (which poisons the ANN shadow index — `docs/conventions.md`).
Fork (`branch.ts` copies canon ≤ `atSeq`) → the fork rebuilds its own digests lazily from its copied
canon; digest rows are not carried across the fork.

---

## 6. The models + runtime — the three LOCAL models (built)

All three run **in-process** (no external services, no ports) on the homelab's 2× RTX A6000, behind
the shared warm/idle lifecycle below. Device/GPU/idle are env-configured.

| Role | Model | How it's used |
|---|---|---|
| **Embedder** | **BGE-M3** (`Xenova/bge-m3`, ONNX) | 1024-dim → `F32_BLOB(1024)`. **CLS pooling + L2-normalize**, **symmetric — NO instruction prefix** (query and digest embedded identically). `EMBED_DEVICE`/`EMBED_DTYPE`, `EMBED_GPU_ID` (default GPU 0). |
| **Reranker** | **bge-reranker-v2-m3** (`onnx-community/bge-reranker-v2-m3-ONNX`, fp16-only) | Cross-encoder: scores `(query, digest)` pairs jointly. **Raw logits for ranking**, `max_length` 1024, batched in 32-pair chunks. **CUDA-only** (fp16 fails to init on the CPU EP). `RERANK_GPU_ID` (default GPU 1). |
| **Summarizer** | **Qwen3-4B-Instruct-2507** GGUF via node-llama-cpp (local) **+ hosted OpenRouter fallback** | Generates each structured digest. Local is **opt-in** via `SUMMARIZER_GGUF` (off by default — no 4GB load at boot); thinking disabled via `budgets.thoughtTokens:0`, Qwen non-thinking sampling. Hosted OpenRouter chat (Haiku / a Qwen) is the drop-in fallback when the GGUF is unset or the GPU is busy. **Local-first.** |

**Why these:** BGE-M3 + bge-reranker are encoders → they map cleanly to ONNX/CUDA and are free + fast
(BGE-M3 ≈1500 texts/s batched on GPU). The summarizer is a generative decoder → node-llama-cpp
(llama.cpp handles GQA in fused kernels, in-process). **Use a non-hybrid Qwen** (Qwen3, not Qwen3.5):
Qwen3.5's hybrid Gated-DeltaNet+SSM arch won't load on node-llama-cpp 3.18.1; disable thinking via the
budget rather than `/no_think`. A model/backend swap = a full re-index because `model` tags the
vector space.

### Shared warm/idle lifecycle — `src/server/embeddings/warm-model.ts` (`WarmModel<T>`)
- **Warm on boot** — `index.ts` fires `warmUpEmbedder()` / `warmUpReranker()` / `warmUpSummarizer()`
  in the background (fire-and-forget; a momentarily-busy GPU never blocks boot). First real request is
  fast (model + ORT-kernel JIT already paid). Embedder/reranker stay warm while a memory-enabled chat
  is active so the per-turn query path is never a cold load.
- **Idle-unload** — a model unused for `IDLE_UNLOAD_MIN` is disposed (VRAM freed for other homelab
  services); the next request cold-reloads transparently. Never mid-inference. `0` = stay warm forever.
- **Failure-reset** — a failed load isn't cached; the next call retries.
- **Per-GPU placement, in-process** — embedder→GPU 0, reranker→GPU 1 via the ONNX EP override
  `session_options.executionProviders=[{name:"cuda",deviceId}]`. No `CUDA_VISIBLE_DEVICES` needed.
  (node-llama-cpp can't pin a device in-process, so the summarizer uses its default placement — fine
  for an occasional background generative call.)
- **One entry point** — `createEmbedder()` / `createReranker()` / `createSummarizer()` are thin
  wrappers over the shared singletons; `embed()`, `embedBatch()`, and `rerank()` all flow through
  `WarmModel.use()`. Single queries, batches, and bulk backfill share the same warm point.

---

## 7. How it plays nice with compaction

**Memory and compaction are orthogonal — both run, neither replaces or feeds the other.** This is the
practical expression of §1 (we keep all messages; the model loses visibility).

- **Compaction manages the live window.** Agent-sdk modes use the SDK's *native* compaction (its
  session carries the summary; we inject nothing). The openrouter modes use the stored
  `compactSummary` / `compactedAtSeq` resume (rebuild history from `compactedAtSeq` forward, inject the
  `{{compact_summary}}` marker). Both are about *fitting the budget*.
- **Memory reaches back past the window.** It re-surfaces aged-out canon as high-signal digests. It is
  exactly the layer that gives the model access to what compaction dropped from view.
- They **coexist in all 4 modes**: memory fills the placeable `{{memory}}` marker in the **dynamic
  (cache-safe) half** of the system prompt — after the cache boundary, so the per-turn digest set
  never busts the cached prefix — and `assemblePrompt` stays pure (`ctx.memory`, like
  `ctx.compactSummary`). On agent-sdk, digests ride *alongside* the SDK's compaction summary; on
  openrouter, alongside `{{compact_summary}}`.
- We explicitly do **NOT** make digests generalize, replace, or feed compaction. (Earlier drafts of
  this doc floated that — it was wrong; drop it.)

---

## 8. Scope decisions (locked)

- **Within-chat ONLY for memory injection. A character must NEVER remember across chats.** Retrieval
  always filters to `chatId`. Cross-chat is only the *user-facing corpus search* scope (§4), never
  in-character injection.
- **No lorebook/world-info routing.** Keyword and topic-anchor concepts live as **fields on the digest
  row**, retrieved by the memory system itself — not by creating world-info entries (the MemoryBooks
  approach). We don't juggle two systems.
- **No horizontal delta-chain at tier-0** (edit-robustness). Delta is vertical, at consolidation tiers
  only (§3).
- **No replacing compaction** (§7). **No cross-chat character memory** (injection). **No settings
  page** — knobs live in the preset `config.params.memory` blob, surfaced later by the preset-editor UI.

**Built:** hierarchical **tiering/consolidation** (§3); **corpus search on the digest substrate** (§4);
the first-class **`chat_segments`** verbatim layer + the **unified `search.corpus`** hybrid; **CSLS
hub-scores** on both new tables; and the **retirement of the old polymorphic `chat_segment`** (Phase B
— `discover`/`knn`/`find` read `chat_segments`; `embed:corpus` no longer emits `chat_segment`).

**Genuinely deferred (features on top of the substrate, zero rework to add later):** side-prompt
**trackers** (a single entry that updates in place — a *different artifact* from a point-in-time
digest), **clips** (user-pinned one-offs), and **user-curated long-term promotion**. The substrate is
designed not to preclude any of these.

---

## 9. What's validated, and what isn't

`scripts/memory-demo.ts` (build-once / query-many; artifact persisted) implements the digest pipeline
on the 222-msg Bess chat — parse → segment into N=16 blocks → digest each → batch-embed → Mix-A block
+ vector-retrieve + local rerank.

- **Per-N-turn digests** compress ~190 older msgs into **~12 digests ≈ 2–4k tokens** (~20× compression)
  — small enough to **inject wholesale** (Mix A). Faithful: digests trace to source `seq`, early canon
  survives, no fabrication in spot-checks.
- **Summarizers tried**: OpenRouter Haiku (clean, $0.12/build) and **local Qwen3-4B-Instruct Q8**
  (in-process, **$0**, ~63s/12 digests, comparable quality) — confirms the local summarizer works.
- **Vector recall + local rerank** is sharp: therapy / spousal-neglect / childhood-history queries
  surface exactly the right digests (rerank cleanly promotes the correct digest over vector's top-1).
- **Topic-anchor + keyword structure** improving retrieval precision is **proven in CharMemory /
  MemoryBooks**, but **not yet quantified on *our* corpus** — that real-corpus quality check is the one
  open validation (run `search.corpus` over the imported archive + spot-check). The substrate, the
  first-class `chat_segments` layer, CSLS on both, and the unified hybrid are all **built** (§4/§11);
  the old `chat_segment` is **retired**.
- **Tiering/consolidation** (Summaryception) is proven in that extension; our tier-1+ consolidation +
  vertical invalidation is the part most likely to need iteration → the test suite covers tier
  consolidation and vertical invalidation explicitly (§11).

---

## 10. Adapted concepts (credit, so we don't re-derive)

We take the best idea from each tool; none is copied wholesale.

- **CharMemory** (`references/sillytavern-character-memory`) — **topic anchor** (front-loaded
  `[entities — scene]`; the precision step-change); **significance litmus** ("mentioned unprompted
  later?" → durable state changes, not play-by-play); **fact extraction** vs scene recap;
  **stable-facts boundary** (the character card is "baseline — do NOT re-extract");
  consolidation-strategy knobs *(future)*.
- **MemoryBooks** (`references/SillyTavern-MemoryBooks`) — **LLM-extracted concrete keywords** as a
  retrieval key; structured **JSON output + validation**; **side-prompt "trackers"** that update one
  entry over time (relationship status / inventory / plot threads) *(future)*; **clips** (one-off
  pinned facts, separate flow) *(future)*; per-chat **summarizer profiles** *(future)*.
- **Summaryception** (`references/Extension-Summaryception`) — **context-aware incremental (delta)
  prompting** reserved for **tier-1 consolidation only**; **seed promotion** (first promotion to a new
  tier is copied verbatim, no LLM, to avoid info loss); **prompt-toggle isolation** (disable the
  creative-writing system prompt during summarization so a small model focuses); **ghosting ≈ our
  canon-is-truth** (hide from context, never delete).
- **qvink** (`references/SillyTavern-MessageSummarize`) — **manual per-summary edit** (no silent
  LLM-driven decay — a bad digest is *fixed*, regenerable from canon); **injection-threshold freeze**
  (hold the inject point steady to preserve prompt cache) — relevant to keeping the dynamic half
  cache-friendly; **pre-summarization noise filtering** (skip very short / OOC / system messages
  before they're ever digested); two-tier short/long with **user curation** *(future)*.

---

## 11. neo-tavern integration seams + next steps

**Foundation (verified against `schema.ts` before building):** per-user (`users`; `chats.ownerId`
NOT NULL → `users`, indexed), versioned-character (`chats.characterVersionId` NOT NULL →
`characterVersions` **RESTRICT** — copy-on-write, pin-protected), swipe (`message_variants` cascade +
`activeVariantIdx`; tip-only, `seq` stable), and fork (`chats.parentChatId` SET NULL; `forkChat`
copies `ownerId` + the shared `characterVersionId` pin + canon ≤ `atSeq`) are all in place. Digests
hang off these correctly: edits flip `editedAt` (staleness); swipes never reach digested territory; a
fork's digests rebuild lazily under its new `chatId`.

**Data model** — a dedicated **`chat_digests`** table (one substrate, two scopes — NOT the polymorphic
`embeddings` table), keyed onto the verified foundation:
- `chatId` → `chats.id` **cascade** (nuke-the-chat cleans up its digests — the FK the polymorphic
  `embeddings` table can't give us).
- `ownerId` → `users.id` NOT NULL, **indexed** (`chat_digests_owner_idx`) — denormalized so per-user
  corpus search is a column filter, not a join; stable per chat.
- `characterVersionId` → `characterVersions.id` NOT NULL **RESTRICT** (mirrors the chat's pin; version
  provenance; corpus "by character" resolves `characterId` via join — denormalize `characterId` only
  if join cost bites).
- `tier` (0 = per-block, 1+ = consolidation), `blockIdx`, `seqStart`/`seqEnd`, `text`, `topicAnchor`,
  `keywords` (JSON), `model`, `summarizerModel`, `embedding F32_BLOB(1024)` (always populated),
  `hubScore`, `tokens`, `createdAt`; unique `(chatId, tier, blockIdx)`; **a `libsql_vector_idx` ANN
  index** (cross-chat corpus search — memory's own read does per-chat in-process cosine and ignores it).

Migration 0018 (drizzle-kit generate, then hand-add the ANN DDL it can't emit). Leaves the locked polymorphic
`embeddings` design untouched for `character` + `chat_segment`. **Forward-correctness note:** those
legacy rows have **no `ownerId`** — fine for single-user, but real multi-user would need per-user
scoping added to the hybrid corpus layer (`chat_digests` already has it).

**Code seams:**
- **`domain/chat/memory.ts`** — REWRITE: `generateDigests(...)` (segment older msgs into `blockSize`
  blocks → structured-digest prompt via `createSummarizer()` → embed via `createEmbedder()` → upsert;
  skip fresh, regenerate stale; **consolidate** filled tiers with seed-promotion) and
  `retrieveMemory(...)` (tiered bridge: high-tier distant + tier-0 recent; B/C: query-embed + cosine +
  keyword + `createReranker()`). `MemoryDeps` → `{ embedder, reranker, summarizer }`. Delete the
  `chat_message` entityType path, `chunkText`, `embedChatMessages`, per-message cosine.
- **`shared/generation.ts`** — REWRITE `GenerationParams.memory` knobs (Zod `.describe()` for the
  future UI): `enabled`, `blockSize`, `verbatimWindow`, `mode: off|mixA|mixB|mixC|tiered`, `fanOut`
  (tier consolidation), `maxTier`, `retrieveK`, `rerankTo`, `minScore`, `keywordMatch`, `summarizer:
  { source: local|hosted, model?, maxTokens?, temperature? }`. (Blob in `presetVersions.config` — safe
  rewrite, no DB migration.)
- **`server/embeddings/summarizer.ts`** — add the hosted OpenRouter path; `createSummarizer(source)`.
- **`domain/chat/send.ts`** — post-turn background **refresh** of this chat's derived data (gated on
  `memory.enabled` + the marker): `generateDigests` + consolidation + re-embed; the same background
  path is where `chat_segment` re-embed for live/edited chats can live (closes the import-only gap).
- **Corpus search** (`domain/search` / `domain/corpus`) — add a digest read path: `chat_digests` ANN
  (filtered by `characterVersionId`/scope, ranked with `hubScore`/CSLS like other entity types) +
  optional `chat_segment` ANN → merge/rerank (the "mix"); hits carry `seqStart`/`seqEnd` for raw
  click-through. `chat_digest` joins the hubness machinery (per-`(entityType, model)` scores).
- **`domain/chat/context.ts`** — keep the gate; call the new `retrieveMemory`; thread `summarizer`.
  **DI** (`service.ts`/`index.ts`) — inject `summarizer` alongside `embedder`/`reranker`.
- **Backfill** — `backfillDigests(chatId)` + `scripts/memory-backfill.ts` (`pnpm memory:backfill`);
  same pipeline as live, replayed start-to-finish (handles tier consolidation in order).
- **Tests** — REWRITE `tests/integration/chat-memory.test.ts` with a deterministic fake embedder +
  fake summarizer; cover dormancy, tiered-bridge injection, **tier consolidation + seed promotion**,
  **vertical invalidation** (deep edit → tier-0 → parent regen), fork rebuild, and a corpus
  digest-search hit linking back to a `seq` span.
- **Docs** — keep this file current; update `docs/data-model.md` with `chat_digests` (tiers, ANN,
  FKs) and the corpus hybrid (`chat_digests` + `chat_segment`).

**Resume order:** (1) `chat_digests` migration + schema (tiers, ANN, FKs); (2) `GenerationParams.memory`
rewrite + hosted summarizer; (3) `domain/chat/memory.ts` generate/consolidate/retrieve (structured,
tiered); (4) post-turn background refresh + DI; (5) corpus digest-search path (hybrid) + hubness;
(6) backfill script; (7) tests; (8) in-app validation on the long chats (memory coherence +
faithfulness vs canon) and a `search.corpus` spot-check.

**Phase B + refinements (BUILT):** `chat_segments` table (migration 0019) + live `generateSegments`
(all chats, whole-chat, embed-only, post-turn behind `CORPUS_AUTOINDEX`); `search.segments` +
unified `search.corpus`; CSLS `computeDigestHubScores`/`computeSegmentHubScores` (via `pnpm csls`);
`discover`/`knn`/`find` migrated to `chat_segments` and the old polymorphic `chat_segment` retired
(not produced or read). The lone open item is quantifying digest-vs-segment search quality on the
real corpus.
