# The neo-tavern memory system — a visual guide

> A show-and-tell companion to the design record in **`docs/memory.md`**. This file is all
> pictures + plain language: hand it to someone and they should be able to *see* how the whole
> thing works without reading a line of code. Every diagram is colour-coded to one legend (below).

## Colour legend

| Colour | Means |
|---|---|
| 🟦 **Canon** | The append-only message log — the source of truth, kept forever |
| 🟩 **Segment** | A *verbatim* 8-message block (raw transcript, embedded) |
| 🟪 **Digest** | A *distilled* structured summary of a block (anchor + facts + keywords, embedded, tiered) |
| 🟧 **Model** | A local/hosted model doing work (embedder, reranker, summarizer) |
| 🟥 **Read path** | Retrieval + what the user/model ultimately receives |
| ⬜ **Prompt / infra** | Prompt assembly, gating, plumbing |

---

## 1. The one idea

Everything below exists to serve a single insight:

> **Canon is append-only and kept *forever*. The model's context window only sees the recent
> tail — older turns fall out of *visibility*, not existence. Memory is the regenerable,
> high-signal index that reaches back past the window and pulls the relevant past forward.**

```mermaid
flowchart LR
    A["📜 The full chat lives in the DB<br/>every message, forever"]:::canon
    A --> B{"Does it still fit in the<br/>model's context window?"}:::infra
    B -->|"recent tail — YES"| C["✅ Model reads it verbatim"]:::canon
    B -->|"aged-out past — NO"| D["🚫 Invisible to the model…"]:::infra
    D --> E["🧠 MEMORY<br/>a compact, searchable index<br/>built from the same canon"]:::digest
    E -->|"re-surface only what's relevant<br/>to the current scene"| C

    classDef canon fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
    classDef digest fill:#f3e8ff,stroke:#9333ea,color:#581c87;
    classDef infra fill:#f1f5f9,stroke:#475569,color:#0f172a;
```

**Memory is orthogonal to compaction.** Compaction (native to the agent-SDK runner) compresses
what's *inside* the window when it fills up. Memory is a *different axis* — it recovers what's
already *fallen out*. Because of that, memory works in **all four provider modes**, including the
OpenRouter chat-completions / responses modes that have no compaction at all.

---

## 2. The substrate — one boundary, two lenses

Every chat is sliced into fixed **8-message blocks**. Each completed block is captured through
**two complementary lenses**, stored as two first-class, foreign-keyed, vector-indexed tables:

```mermaid
flowchart TD
    MSG["📜 Canon: messages 0…7<br/>(one 8-message block)"]:::canon

    MSG --> SEG["🟩 SEGMENT — verbatim lens<br/>the raw transcript of the block"]:::segment
    MSG --> DIG["🟪 DIGEST — distilled lens<br/>topic anchor + key facts + keywords"]:::digest

    SEG --> ST[("chat_segments<br/>• text (full transcript)<br/>• embedding F32_BLOB(1024)<br/>• seqStart…seqEnd<br/>• ANN: chat_segments_ann")]:::segment
    DIG --> DT[("chat_digests<br/>• text + topicAnchor + keywords<br/>• tier (0 = block, 1+ = merged)<br/>• embedding F32_BLOB(1024)<br/>• seqStart…seqEnd<br/>• ANN: chat_digests_ann")]:::digest

    ST -.->|"FK: chatId · ownerId · characterVersionId"| FK["🔒 owned, versioned,<br/>cascade-safe"]:::infra
    DT -.->|"FK: chatId · ownerId · characterVersionId"| FK

    classDef canon fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
    classDef segment fill:#dcfce7,stroke:#16a34a,color:#14532d;
    classDef digest fill:#f3e8ff,stroke:#9333ea,color:#581c87;
    classDef infra fill:#f1f5f9,stroke:#475569,color:#0f172a;
```

**Why two?** A raw 8-message chunk embeds *noisily* — every chunk looks vaguely similar, so
similarity search returns mush. The digest distills the **load-bearing signal**, so it retrieves
cleanly. We keep **both, permanently, linked** by the same `(chatId, blockIdx, seq-span)`: the
digest is the sharp search key; the segment is the verbatim ground truth it points back to.

---

## 3. What a *digest* actually is

A tier-0 digest is not a paragraph summary. It's a **structured, retrieval-optimised** unit with
three parts, produced under a strict prompt:

```mermaid
flowchart LR
    BLK["🟦 8-message block"]:::canon --> SUM["🟧 Summarizer<br/>(structured prompt)"]:::model
    SUM --> ANCH["📌 Topic anchor<br/><i>[entities — scene]</i><br/>mandatory first line"]:::digest
    SUM --> FACT["🔑 Significance-filtered facts<br/>litmus: <i>“will this matter later?”</i>"]:::digest
    SUM --> KW["🏷️ 8–20 concrete keywords<br/>distinctive retrieval anchors"]:::digest

    classDef canon fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
    classDef model fill:#fef3c7,stroke:#d97706,color:#78350f;
    classDef digest fill:#f3e8ff,stroke:#9333ea,color:#581c87;
```

**A real digest the pipeline produced** (block 2 of a 222-message chat; one character renamed for sharing):

```
[Wyatt & Bess — Midnight Crossing, the Unleashed RX-78-2]
- Wyatt revealed he bought a Bandai PG Perfect Grade Unleashed RX-78-2 Gundam ($350, 3,500 pieces) as his first kit — deliberately, to make Bess come help him build it.
- Bess committed to building the Unleashed with him and declared it nonnegotiable.
- Wyatt started watching Mobile Suit Gundam SEED (the "wrong" entry point) on purpose to bait Bess into coming over.
- Bess crossed the street at 11:42 PM, walked in without knocking, and took the tablet to stop him — they settled on 08th MS Team instead.
keywords: Unleashed RX-78-2, Perfect Grade, $350 kit, 3,500 pieces, Gundam SEED,
          08th MS Team, midnight crossing, build-it-together, foreclosure house, Samui
```

Keywords like *"Unleashed RX-78-2"* or *"08th MS Team"* are exactly the kind of
distinctive tokens that retrieve precisely — which a raw transcript chunk would bury.

---

## 4. The write path — how memory gets built

Both lenses are generated **after a turn completes** (fire-and-forget, never blocking the reply)
*and* in bulk by the backfill script for imported history. Same functions, same result.

```mermaid
flowchart TD
    TRIG["⏱️ Trigger<br/>post-turn hook (send.ts) · or · pnpm memory:backfill"]:::infra

    TRIG --> SEGGEN["generateSegments()"]:::segment
    TRIG --> DIGGEN["generateDigests()"]:::digest

    subgraph SEGPATH["🟩 Segment path — verbatim, EVERY block, all chats → 100% coverage"]
        SEGGEN --> SBLK["chunk whole chat into ALL 8-msg blocks<br/>(incl. the trailing partial / a whole short chat)"]:::segment
        SBLK --> SEMB["🟧 BGE-M3 embed (GPU, token-budget batched)"]:::model
        SEMB --> SUP["upsert chat_segments"]:::segment
    end

    subgraph DIGPATH["🟪 Digest path — distilled, only the aged-out past"]
        DIGGEN --> CUT["cutoff = maxSeq − verbatimWindow(8)<br/>keep only messages that have aged out"]:::digest
        CUT --> ELIG{"≥ 1 full 8-msg block<br/>below the window?"}:::infra
        ELIG -->|no| SKIP["do nothing<br/>(short chat = fully visible)"]:::infra
        ELIG -->|yes| T0["per block → 🟧 Summarizer → structured digest"]:::digest
        T0 --> DEMB["🟧 BGE-M3 embed"]:::model
        DEMB --> DUP["upsert chat_digests (tier 0)"]:::digest
        DUP --> CONS["🟧 consolidate tiers (see §5)"]:::digest
    end

    SUP --> CSLS["🟧 pnpm csls — compute hub_score<br/>per (entityType, model)"]:::model
    CONS --> CSLS

    classDef infra fill:#f1f5f9,stroke:#475569,color:#0f172a;
    classDef segment fill:#dcfce7,stroke:#16a34a,color:#14532d;
    classDef digest fill:#f3e8ff,stroke:#9333ea,color:#581c87;
    classDef model fill:#fef3c7,stroke:#d97706,color:#78350f;
```

**The summarizer is free-first:** a local **Qwen3-4B-Instruct GGUF** (in-process, node-llama-cpp)
when configured, otherwise a hosted **Claude Haiku** fallback over the existing chat-completions
runner. The embedder/reranker run in-process on the homelab GPUs (onnxruntime CUDA).

**It self-heals.** A block is only re-digested if it's **missing or stale** — its seq-span changed,
or a message in it was edited *after* the digest was written. Swipes/edits at the live tip never
touch settled digests (that's what the 8-message verbatim window protects), and a fork lazily
rebuilds only what diverged.

---

## 5. The tiering — keeping "the story so far" bounded

If we injected *every* tier-0 digest, a 1000-message chat would inject 60+ of them. Instead, blocks
**consolidate upward**: every `fanOut = 4` lower-tier digests merge into one coarser digest, with a
delta prompt (*"here are prior consolidations — do NOT repeat them"*). The arc stays compact as the
chat grows.

```mermaid
flowchart BT
    subgraph T0["🟪 Tier 0 — one digest per 8-msg block (fine-grained)"]
        b0["b0"]:::digest --- b1["b1"]:::digest --- b2["b2"]:::digest --- b3["b3"]:::digest
        b4["b4"]:::digest --- b5["b5"]:::digest --- b6["b6"]:::digest --- b7["b7 …"]:::digest
    end
    subgraph T1["🟪 Tier 1 — every 4 blocks merged (coarse arc)"]
        c0["consolidation 0<br/>covers blocks 0–3"]:::digest
        c1["consolidation 1<br/>covers blocks 4–7"]:::digest
    end
    b0 --> c0
    b1 --> c0
    b2 --> c0
    b3 --> c0
    b4 --> c1
    b5 --> c1
    b6 --> c1
    b7 --> c1
    c0 --> T2["🟪 Tier 2 — every 4 tier-1s merged<br/>(only your longest chats — tier-3 unused at ≤222 msgs)"]:::digest
    c1 --> T2

    classDef digest fill:#f3e8ff,stroke:#9333ea,color:#581c87;
```

The tier-1 anchor for blocks 0–3 of that same chat read:
*"[Wyatt & Bess — Twelve Years Later: a Reunion, a Gundam Build, and Old Family History]"* — a
genuine cross-block synthesis, not a concatenation.

This is what the **`tiered`** read mode (next section) consumes: a **bridge** of coarse high-tier
digests for the distant past + fine tier-0 digests for the recent past — so the injected
"story so far" stays at a roughly constant token budget no matter how long the chat runs.

---

## 6. Two scopes, two read paths

The **same substrate** serves two very different questions. This is the heart of the system.

The within-chat path is **flat query-driven RAG**, modeled on SillyTavern's native Vector Storage:
the **last 2 messages** form the query, the most relevant tier-0 digests are retrieved (+ reranked),
and injected. **`mixC` is the default**; `mixA` (inject every tier-0) and `tiered` (the consolidation
bridge) are opt-in "give me the whole arc" modes. The injected set is tiny (~3 digests ≈ 1k tokens),
so it's window-independent — the 32k/200k context size only bounds how much *raw* history the runner
sends, not memory.

```mermaid
flowchart TD
    Q["a query"]:::infra --> SCOPE{"which scope?"}:::infra

    %% ---------- within-chat ----------
    subgraph IN["🟥 WITHIN-CHAT memory injection — “what happened earlier in THIS chat?”"]
        direction TB
        RQ["query = the last 2 messages"]:::infra --> MODE{"mode (default mixC)"}:::infra
        MODE -->|mixA| A0["all tier-0 digests of this chat"]:::digest
        MODE -->|tiered| AT["coarse-old + fine-recent<br/>(digests not covered by a higher tier)"]:::digest
        MODE -->|mixB / mixC| AV["🟧 embed query → <b>exact cosine</b> over<br/>THIS chat's tier-0 digests + keyword match"]:::model
        AV --> RR{"mixC?"}:::infra
        RR -->|yes| RRK["🟧 cross-encoder rerank → top rerankTo"]:::model
        RR -->|no| TOPK["top retrieveK"]:::digest
        RRK --> FILL
        TOPK --> FILL
        A0 --> FILL
        AT --> FILL
        FILL["fills the {{memory}} marker"]:::read
    end

    %% ---------- cross-chat ----------
    subgraph CROSS["🟥 CROSS-CHAT corpus search — “where, across ALL my chats, did X happen?”"]
        direction TB
        CQ["query text"]:::infra --> CEMB["🟧 BGE-M3 embed"]:::model
        CEMB --> ANND["ANN: chat_digests_ann<br/>(owner-scoped)"]:::digest
        CEMB --> ANNS["ANN: chat_segments_ann<br/>(owner-scoped)"]:::segment
        ANND --> CSL["CSLS hubness adjust<br/>dist − 1 + hub_score"]:::infra
        ANNS --> CSL
        CSL --> MRG["merge into ONE candidate pool"]:::infra
        MRG --> JR["🟧 joint cross-encoder rerank<br/>(digests + segments together)"]:::model
        JR --> DD["dedupe per block<br/>(digest + segment → better lens)"]:::infra
        DD --> HITS["ranked hits → each links back to a seqStart…seqEnd span"]:::read
    end

    SCOPE -->|"this chat only"| RQ
    SCOPE -->|"my whole corpus"| CQ

    classDef infra fill:#f1f5f9,stroke:#475569,color:#0f172a;
    classDef digest fill:#f3e8ff,stroke:#9333ea,color:#581c87;
    classDef segment fill:#dcfce7,stroke:#16a34a,color:#14532d;
    classDef model fill:#fef3c7,stroke:#d97706,color:#78350f;
    classDef read fill:#ffe4e6,stroke:#e11d48,color:#881337;
```

| | **Within-chat injection** | **Cross-chat corpus search** |
|---|---|---|
| Question | "What happened earlier in *this* chat?" | "Where, across *all* my chats, did X happen?" |
| Scope | one chat | the whole owner corpus |
| Match | **exact in-process cosine** (small, this chat) | **global ANN** (`vector_top_k`) + **CSLS** |
| Sources | tier-0 digests | **all digests *and* all segments** (hybrid) |
| Reranks | yes — mixC is the default | yes — one joint list |
| Output | text that fills `{{memory}}` | ranked hits → `seq` spans back to canon |

> **CSLS** corrects "hub" vectors — a few generic digests that sit suspiciously close to
> *everything* — by penalising them with a per-group hubness score, so true relevance wins.

**Retrieval in action** — an illustrative run (the discrimination mechanism is what matters, and is
unchanged by block size): the within-chat path embeds the query and cosines over this chat's tier-0
digests:

| Query | Top digest surfaced | sim |
|---|---|---|
| *"which Gundam kit did they decide to build together?"* | block 2 — *[Wyatt & Bess — Midnight Crossing]* (names the Unleashed RX-78-2) | 0.53 |
| *"the night she ran across the street to stop him watching the wrong show"* | block 2 — *[Wyatt & Bess — Midnight Crossing]* | 0.56 |
| *"the four-hour garage talk about building mobile suits"* | block 1 — *[Wyatt & Bess — Garage reunion]* | 0.62 |

Note the discrimination: the *general* "mobile suits" talk pulls **block 1**, while the *specific*
build-night decision pulls **block 2** — two adjacent, topically-similar blocks stay cleanly
separable because the anchors + keywords give each a distinct fingerprint. Raw-chunk embeddings,
which all collapse toward the same "two people chatting" vector, can't make that split.

---

## 7. Where the injected memory lands

Within-chat retrieval fills the `{{memory}}` marker, which lives in the **dynamic (cache-safe)**
half of the system prompt — *after* the cache boundary — so the per-turn memory set never busts the
cached static prefix.

```mermaid
flowchart LR
    subgraph PROMPT["the assembled system prompt"]
        direction TB
        STAT["⬜ STATIC half (cached, paid once)<br/>persona · character · always-on world info"]:::prompt
        BND{{"✂️ cache boundary"}}:::infra
        DYN["⬜ DYNAMIC half (cache-safe, rebuilt per turn)<br/>keyword world info · <b>{{memory}}</b> ← injected here"]:::read
        STAT --- BND --- DYN
    end
    PROMPT --> RUN["sent through whichever of the 4 provider modes the chat is on"]:::infra

    classDef prompt fill:#f1f5f9,stroke:#475569,color:#0f172a;
    classDef infra fill:#e2e8f0,stroke:#475569,color:#0f172a;
    classDef read fill:#ffe4e6,stroke:#e11d48,color:#881337;
```

---

## 8. The whole thing, end to end

```mermaid
flowchart LR
    subgraph SRC["🟦 source of truth"]
        CANON["append-only messages<br/>(kept forever)"]:::canon
    end

    subgraph BUILD["build (post-turn / backfill)"]
        SEG["🟩 segments<br/>verbatim blocks"]:::segment
        DIG["🟪 digests<br/>distilled + tiered"]:::digest
    end

    subgraph READ["read"]
        INJ["🟥 within-chat → {{memory}}"]:::read
        SRCH["🟥 cross-chat corpus search"]:::read
    end

    CANON -->|"complete blocks → 🟧 embed"| SEG
    CANON -->|"aged-out blocks → 🟧 summarize → embed"| DIG
    DIG -->|"this chat, exact cosine"| INJ
    SEG -->|"all chats, ANN"| SRCH
    DIG -->|"all chats, ANN"| SRCH
    SRCH -->|"hits link back to seq spans"| CANON

    classDef canon fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
    classDef segment fill:#dcfce7,stroke:#16a34a,color:#14532d;
    classDef digest fill:#f3e8ff,stroke:#9333ea,color:#581c87;
    classDef read fill:#ffe4e6,stroke:#e11d48,color:#881337;
```

---

## 9. Built today vs. enabled later

The substrate above is the hard part, and it's **built and validated**. A few features sit *on top*
of it with zero rework required — the design deliberately doesn't preclude them:

| ✅ Built | 🔜 Enabled later (substrate-ready) |
|---|---|
| Structured tier-0 digests + hierarchical consolidation | **Trackers** — a single entry that updates in place (relationship status, inventory, plot threads) |
| Verbatim `chat_segments` + the hybrid corpus search | **Clips** — user-pinned one-off facts |
| CSLS hubness on both tables | **User-curated long-term promotion** — hand-pick what persists |
| Edit/fork-aware lazy regeneration | Per-chat summarizer profiles |

Because every digest is a **pure function of canon**, none of these risk corrupting the source of
truth — they're just additional lenses over the same append-only log.

---

### Knobs (all per-preset, surfaced in the UI later)

`blockSize` (8) · `verbatimWindow` (8) · `queryWindow` (2) · `mode` (default **mixC**; off / mixA /
mixB / mixC / tiered) · `fanOut` (4) · `maxTier` (3) · `retrieveK` (4) · `rerankTo` (3) ·
`minScore` (0.25) · `keywordMatch` · `summarizer` (local-first Qwen-4B → hosted Haiku fallback).

*Defaults re-derived from the real corpus for the 32k window (`docs/memory.md` §9). All three vector
tables — `character_embeddings`, `chat_digests`, `chat_segments` — are owner-keyed + FK'd. Schema:
`src/db/schema.ts`.*
