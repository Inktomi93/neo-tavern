import type { MemoryConfig } from "./types";

export const DEFAULTS = {
  blockSize: 8, // ~3k BGE tok/block (median) — under the 8192 cap (16-msg blocks truncate 24%); finer digests
  verbatimWindow: 8, // recent tail never digested — ST's `protect` zone, NOT a context-budget knob
  queryWindow: 2, // recent messages forming the retrieval query (ST native vectors `query: 2`)
  mode: "mixC" as NonNullable<MemoryConfig["mode"]>, // flat query-driven RAG (ST model) is the default
  fanOut: 4,
  maxTier: 3,
  retrieveK: 8, // over-fetch for rerank (reviewer #6: top-4 too tight on long chats; rerank cost negligible)
  rerankTo: 3,
  minScore: 0.25, // ST `score_threshold`
  keywordMatch: true,
  recencyBias: 0, // mild boost toward recent digests in mixB/mixC (reviewer #2); 0 = off, wired for ablation
} as const;

// Interfaces moved to types.ts
export const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    topicAnchor: { type: "string" },
    // maxItems is enforced by the grammar (GbnfJsonArraySchema) — it BOUNDS the output so a verbose
    // small model can't produce 40+ keywords and overflow maxTokens (→ truncated, unparseable JSON).
    facts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
    keywords: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 20 },
  },
  required: ["topicAnchor", "facts", "keywords"],
};

export const TIER0_SYSTEM = `You are the memory-keeper for a long roleplay. Distill ONE block of conversation into a compact, searchable digest that will be retrieved later (turns or weeks on) to remind the writer what happened here. Capture only what is DURABLE — things that would be referenced unprompted later.

Respond with ONLY a JSON object of this exact shape (no prose, no markdown, no <think>):
{"topicAnchor": "...", "facts": ["...", "..."], "keywords": ["...", "..."]}

How to fill each field:
- topicAnchor: one short label "[key participants — the specific event/scene]". Concrete and DISTINCTIVE — the single handle that separates this scene from every other. Not a generic mood.
- facts: 1-6 durable beats — state changes, decisions, revelations, relationship shifts, lasting consequences. Each fact stands ALONE (use names, not pronouns), third person, past tense. NO play-by-play, no moment-to-moment action, no atmosphere.
- keywords: 4-20 concrete, scene-specific SEARCH tokens — proper nouns, named objects, places, distinctive actions/phrases someone might later search for. NOT abstract themes, NOT bare character names, NOT generic words.

Example (shows the shape + judgment — do NOT copy its content):
{"topicAnchor":"[Roan & the Cartographer — the drowned archive, lantern descent]","facts":["Roan admitted the brass key was his late mentor's, recasting the expedition as grief, not theft","They struck a deal — Roan keeps the journal, the Cartographer keeps any star-charts — their first real trust"],"keywords":["brass key","drowned archive","mentor's journal","star-charts","lantern descent","the Cartographer","dusk-flood deadline"]}`;

// Tier 1+: consolidate several lower-tier digests into one coarser digest. Context-aware (sees the
// prior consolidations at this tier) so it emits a non-redundant higher-level recap.
export const CONSOLIDATE_SYSTEM = `You are the memory-keeper for a long roleplay. Merge several sequential scene digests (and, when given, the consolidated digests that already precede them) into ONE coarser ARC-level digest — a higher-altitude view of this stretch of the story. Keep the throughline (major events, turning points, lasting changes); drop fine detail already implied. Do NOT repeat anything covered by the prior consolidated digests.

Respond with ONLY a JSON object of this exact shape (no prose, no markdown, no <think>):
{"topicAnchor": "...", "facts": ["...", "..."], "keywords": ["...", "..."]}

How to fill each field:
- topicAnchor: one short label "[key participants — this span's defining turns]". SAME bracket format as a scene digest, but it names what makes THIS span distinct from the spans around it — its specific turning points, NOT the relationship's general theme. It must be DISTINCTIVE: a reader should be able to tell this arc from its neighbors by the anchor alone. "[Roan & the Cartographer — their growing trust and shared journey]" is WRONG (it fits any stretch); "[Roan & the Cartographer — grave-robbing to alliance: the drowned archive through the harbor betrayal]" is RIGHT.
- facts: 1-6 arc-level beats — the developments that still matter at this altitude (turning points, revelations, lasting changes). Name the specific events of THIS span, not the relationship in general. Each stands ALONE (use names, not pronouns), third person, past tense. Concrete events, not summary adjectives.
- keywords: 4-20 concrete, distinctive search tokens spanning the merged scenes (proper nouns, named objects, places, signature actions/phrases). NOT abstract themes, NOT bare character names.

Example (shows the shape + judgment — do NOT copy its content):
{"topicAnchor":"[Roan & the Cartographer — grave-robbing to alliance: the drowned archive through the harbor betrayal]","facts":["Roan's expedition was revealed as grief over his dead mentor, not treasure-hunting, which turned the Cartographer's distrust into partnership","They escaped the dusk-flood with the star-charts but lost the mentor's journal to the harbor-master, who now hunts them both","Their first shared enemy replaced their rivalry — the alliance held through the betrayal"],"keywords":["drowned archive","star-charts","mentor's journal","dusk-flood","harbor-master","brass key","the harbor betrayal","first shared enemy"]}`;
