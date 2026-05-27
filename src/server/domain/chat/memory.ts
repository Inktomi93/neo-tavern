// Within-chat MEMORY — the structured-digest system (docs/memory.md). Canon is truth; digests are a
// derived, regenerable index over the append-only `messages` table. We keep every message forever,
// including those that age out of the model's context window — memory is what re-surfaces that
// aged-out canon into the prompt (orthogonal to compaction, which manages the live window).
//
// The unit is a per-N-turn STRUCTURED digest: a topic-anchor first line + significance-filtered
// facts + concrete keywords (the structure is what makes RP prose retrieve with clean signal —
// raw chunks all embed into the same mush). tier 0 = per-block (independent — a deep edit only
// re-digests its own block); tier 1+ = consolidation (digest-of-digests) so the injected
// story-so-far stays budget-bounded as a chat grows past today's max.
//
// Lives IN domain/chat (uses the embeddings INFRA directly). Retrieval is EXACT in-process cosine
// over THIS chat's digests (never the global ANN — that's the separate cross-chat corpus scope).

import { asc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import {
  characterVersions,
  chatDigests,
  chatSegments,
  chats,
  messages,
  personas,
} from "../../../db/schema";
import type { GenerationParams } from "../../../shared/generation";
import type { Embedder } from "../../embeddings/embedder";
import type { Reranker } from "../../embeddings/reranker";
import type { Summarizer } from "../../embeddings/summarizer";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";

type MemoryConfig = NonNullable<GenerationParams["memory"]>;

// Defaults (docs/memory.md §3/§5). blockSize/verbatimWindow are message counts; minScore is cosine.
const DEFAULTS = {
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

// Retrieval needs the embedder (query vector, mixB/C) + reranker (mixC); generation needs the
// embedder (digest vectors) + summarizer. Two narrow dep shapes so callers inject only what they use.
export interface RetrieveMemoryDeps {
  embedder: Embedder;
  reranker: Reranker;
}
export interface GenerateDigestsDeps {
  embedder: Embedder;
  summarizer: Summarizer;
}

interface MsgRow {
  seq: number;
  role: string;
  content: string;
  editedAt: number | null;
}
interface DigestRow {
  tier: number;
  blockIdx: number;
  seqStart: number;
  seqEnd: number;
  text: string;
  keywords: string[];
  createdAt: number;
  embedding: Float32Array | null;
}
// A staged (re)write before the batched embed + upsert.
interface PendingDigest {
  tier: number;
  blockIdx: number;
  seqStart: number;
  seqEnd: number;
  text: string;
  topicAnchor: string | null;
  keywords: string[];
  summarizerModel: string;
}

function resolveCfg(p: MemoryConfig) {
  return {
    enabled: p.enabled ?? false,
    blockSize: p.blockSize ?? DEFAULTS.blockSize,
    verbatimWindow: p.verbatimWindow ?? DEFAULTS.verbatimWindow,
    queryWindow: p.queryWindow ?? DEFAULTS.queryWindow,
    mode: p.mode ?? DEFAULTS.mode,
    fanOut: p.fanOut ?? DEFAULTS.fanOut,
    maxTier: p.maxTier ?? DEFAULTS.maxTier,
    retrieveK: p.retrieveK ?? DEFAULTS.retrieveK,
    rerankTo: p.rerankTo ?? DEFAULTS.rerankTo,
    minScore: p.minScore ?? DEFAULTS.minScore,
    keywordMatch: p.keywordMatch ?? DEFAULTS.keywordMatch,
    recencyBias: p.recencyBias ?? DEFAULTS.recencyBias,
    summarizerSource: p.summarizer?.source,
    summarizerMaxTokens: p.summarizer?.maxTokens,
    summarizerTemperature: p.summarizer?.temperature,
  };
}

// ── prompts ──────────────────────────────────────────────────────────────────

// Tier-0: structured, INDEPENDENT (no prior-digest chain). Topic anchor (CharMemory's precision
// step-change) + significance-filtered facts ("mentioned later?" litmus) + concrete keywords
// (MemoryBooks). The structure is the retrieval signal.
// JSON schema for grammar-constrained digests. On the LOCAL path this is compiled to a GBNF grammar
// so the sampler CANNOT malform the shape (the b21/b24 keyword-dump-in-the-anchor failure becomes
// impossible); the hosted path asks for the same JSON in the prompt. parseDigest reads it (free-text
// fallback for safety / the fake test summarizer).
const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    topicAnchor: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: ["topicAnchor", "facts", "keywords"],
};

const TIER0_SYSTEM = `You are a memory keeper for a roleplay. Read the conversation block and capture ONLY what is durable — events, revelations, decisions, relationship shifts, concrete facts (names, places, objects). Skip play-by-play and in-the-moment chatter (litmus: would someone bring this up unprompted weeks later?).

Respond with ONLY a JSON object of this exact shape:
{"topicAnchor": "[<key entities> — <specific scene label>]", "facts": ["<durable fact>", "..."], "keywords": ["<concrete term>", "..."]}

2-5 facts. 8-20 keywords: concrete scene-specific tokens (locations, objects, proper nouns, unique actions) — NOT abstract themes or character names. Third person, past tense. No prose outside the JSON, no <think>.`;

// Tier 1+: consolidate several lower-tier digests into one coarser digest. Context-aware (sees the
// prior consolidations at this tier) so it emits a non-redundant higher-level recap.
const CONSOLIDATE_SYSTEM = `You are a memory keeper for a roleplay. You are given several sequential digests of earlier scenes and (optionally) the consolidated digests that already precede them. Merge the new digests into ONE coarser digest that preserves the durable arc — major events, turning points, lasting changes — dropping fine detail already implied. Do NOT repeat anything in the prior consolidated digests.

Respond with ONLY a JSON object of this exact shape:
{"topicAnchor": "[<key entities> — <arc label>]", "facts": ["<durable beat>", "..."], "keywords": ["<concrete term>", "..."]}

3-6 facts. 8-20 keywords. Third person, past tense. No prose outside the JSON, no <think>.`;

function renderTranscript(block: MsgRow[], charName: string, userName: string): string {
  return block
    .map((m) => `${m.role === "user" ? userName : charName}: ${m.content.trim()}`)
    .join("\n\n");
}

// Parse the model's structured output → the stored fields. Lenient: a missing KEYWORDS line just
// yields no keywords; the topic anchor falls back to the first non-empty line.
function parseDigest(raw: string): {
  text: string;
  topicAnchor: string | null;
  keywords: string[];
} {
  const trimmed = raw.trim();
  // JSON-first: the local path is grammar-constrained to DIGEST_SCHEMA, the hosted path is prompted
  // for the same JSON. Slice the outermost {...} so stray prose around it is tolerated.
  const js = trimmed.indexOf("{");
  const je = trimmed.lastIndexOf("}");
  if (js !== -1 && je > js) {
    try {
      const o = JSON.parse(trimmed.slice(js, je + 1)) as {
        topicAnchor?: unknown;
        facts?: unknown;
        keywords?: unknown;
      };
      const anchor = typeof o.topicAnchor === "string" ? o.topicAnchor.trim() : null;
      const facts = Array.isArray(o.facts)
        ? o.facts.filter((f): f is string => typeof f === "string")
        : [];
      const keywords = Array.isArray(o.keywords)
        ? o.keywords
            .filter((k): k is string => typeof k === "string")
            .map((k) => k.trim())
            .filter(Boolean)
        : [];
      if (anchor || facts.length > 0) {
        // Reconstruct the stored/embedded text from the structured fields (anchor + bullet facts).
        const text = [anchor, ...facts.map((f) => `- ${f}`)].filter(Boolean).join("\n");
        return { text, topicAnchor: anchor, keywords };
      }
    } catch {
      // malformed JSON → fall through to the free-text parser
    }
  }
  // Free-text fallback (the legacy "[anchor]\n- fact\nKEYWORDS: …" shape) — hosted output that
  // ignored the JSON ask, or the deterministic fake summarizer in tests.
  const lines = trimmed.split("\n");
  const kwIdx = lines.findIndex((l) => /^\s*keywords\s*:/i.test(l));
  let keywords: string[] = [];
  if (kwIdx !== -1) {
    keywords = (lines[kwIdx] ?? "")
      .replace(/^\s*keywords\s*:/i, "")
      .split(/[,;]/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
  }
  const bodyLines = kwIdx === -1 ? lines : lines.slice(0, kwIdx);
  const text = bodyLines.join("\n").trim();
  const anchorLine = bodyLines.find((l) => l.trim().length > 0)?.trim() ?? null;
  return { text, topicAnchor: anchorLine, keywords };
}

// Cosine of two L2-normalized vectors = their dot product (the embedder normalizes).
function cosineSim(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

// Chunk an ordered array into fixed-size blocks; the final block may be short (it grows and
// re-digests as more messages age out).
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadDigests(db: Db, chatId: string): Promise<DigestRow[]> {
  const rows = await db
    .select({
      tier: chatDigests.tier,
      blockIdx: chatDigests.blockIdx,
      seqStart: chatDigests.seqStart,
      seqEnd: chatDigests.seqEnd,
      text: chatDigests.text,
      keywords: chatDigests.keywords,
      createdAt: chatDigests.createdAt,
      embedding: chatDigests.embedding,
    })
    .from(chatDigests)
    .where(eq(chatDigests.chatId, chatId));
  return rows.map((r) => ({
    tier: r.tier,
    blockIdx: r.blockIdx,
    seqStart: r.seqStart,
    seqEnd: r.seqEnd,
    text: r.text,
    keywords: Array.isArray(r.keywords) ? (r.keywords as string[]) : [],
    createdAt: r.createdAt,
    embedding: r.embedding,
  }));
}

async function loadHistory(db: Db, chatId: string): Promise<MsgRow[]> {
  const rows = await db
    .select({
      seq: messages.seq,
      role: messages.role,
      content: messages.content,
      editedAt: messages.editedAt,
    })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.seq));
  return rows.filter((m) => m.role !== "system" && m.content.trim().length > 0);
}

interface ChatMeta {
  ownerId: string;
  characterVersionId: string;
  charName: string;
  userName: string;
}

// Resolve the chat's owner + pinned character version + display names (char = the cv name; user =
// the active-or-pinned persona, else "User"). Shared by generateDigests + generateSegments.
async function loadChatMeta(db: Db, chatId: string): Promise<ChatMeta | null> {
  const rows = await db
    .select({
      ownerId: chats.ownerId,
      characterVersionId: chats.characterVersionId,
      personaId: chats.personaId,
      pinnedPersonaId: chats.pinnedPersonaId,
    })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  const chat = rows[0];
  if (!chat) return null;
  const cvRows = await db
    .select({ name: characterVersions.name })
    .from(characterVersions)
    .where(eq(characterVersions.id, chat.characterVersionId))
    .limit(1);
  const charName = cvRows[0]?.name ?? "Assistant";
  const personaId = chat.personaId ?? chat.pinnedPersonaId;
  let userName = "User";
  if (personaId) {
    const pRows = await db
      .select({ name: personas.name })
      .from(personas)
      .where(eq(personas.id, personaId))
      .limit(1);
    userName = pRows[0]?.name ?? "User";
  }
  return {
    ownerId: chat.ownerId,
    characterVersionId: chat.characterVersionId,
    charName,
    userName,
  };
}

async function loadSegments(
  db: Db,
  chatId: string,
): Promise<{ blockIdx: number; seqStart: number; seqEnd: number; createdAt: number }[]> {
  return db
    .select({
      blockIdx: chatSegments.blockIdx,
      seqStart: chatSegments.seqStart,
      seqEnd: chatSegments.seqEnd,
      createdAt: chatSegments.createdAt,
    })
    .from(chatSegments)
    .where(eq(chatSegments.chatId, chatId));
}

// Embed the staged digests in ONE batched GPU pass, then upsert (idempotent on the unique
// (chatId,tier,blockIdx) — a regenerated block overwrites in place). Returns how many were written.
async function embedAndUpsert(
  db: Db,
  embedder: Embedder,
  chatId: string,
  ownerId: string,
  characterVersionId: string,
  rows: PendingDigest[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const vecs = await embedder.embedBatch(rows.map((r) => r.text));
  const createdAt = Date.now();
  let written = 0;
  for (const [i, r] of rows.entries()) {
    const vec = vecs[i];
    if (vec === undefined) continue;
    const fields = {
      seqStart: r.seqStart,
      seqEnd: r.seqEnd,
      text: r.text,
      topicAnchor: r.topicAnchor,
      keywords: r.keywords,
      model: embedder.model,
      summarizerModel: r.summarizerModel,
      embedding: vec,
      // Rough token estimate (cost visibility); the embedder enforces the real BGE-M3 8192 cap.
      tokens: Math.round(r.text.length / 4),
      createdAt,
    };
    await db
      .insert(chatDigests)
      .values({
        id: newId(),
        chatId,
        ownerId,
        characterVersionId,
        tier: r.tier,
        blockIdx: r.blockIdx,
        ...fields,
      })
      .onConflictDoUpdate({
        target: [chatDigests.chatId, chatDigests.tier, chatDigests.blockIdx],
        set: fields,
      });
    written += 1;
  }
  return written;
}

// ── generation (background; never on the reply critical path) ──────────────────

/**
 * (Re)build this chat's digests from canon: segment OLDER messages (aged below `verbatimWindow`) into
 * `blockSize` tier-0 blocks, (re)digest stale/missing ones independently, then consolidate filled
 * tiers up to `maxTier`. Idempotent + incremental — only stale/missing blocks call the summarizer.
 * Stale = the block's span changed (grew) OR a contained message was edited after the digest was
 * written (`editedAt > createdAt`); a regenerated child marks its parent stale (bounded vertical
 * cascade). Returns how many digests were (re)written. Used live (post-turn) and for bulk backfill.
 */
export async function generateDigests(
  db: Db,
  deps: GenerateDigestsDeps,
  opts: { chatId: string; params: MemoryConfig },
): Promise<{ written: number }> {
  const cfg = resolveCfg(opts.params);
  if (!cfg.enabled || cfg.mode === "off") return { written: 0 };

  const chat = await loadChatMeta(db, opts.chatId);
  if (!chat) return { written: 0 };
  const { charName, userName } = chat;

  const history = await loadHistory(db, opts.chatId);
  if (history.length === 0) return { written: 0 };

  // Dormancy / eligibility: only digest messages aged below the verbatim window. A fresh chat (or one
  // with < one block aged out) does nothing — the seam buffer keeps live swipes/edits off digests.
  const maxSeq = history[history.length - 1]?.seq ?? 0;
  const cutoff = maxSeq - cfg.verbatimWindow;
  const older = history.filter((m) => m.seq <= cutoff);
  if (older.length < cfg.blockSize) return { written: 0 };

  const summarizeOpts = {
    source: cfg.summarizerSource,
    maxTokens: cfg.summarizerMaxTokens,
    temperature: cfg.summarizerTemperature,
    jsonSchema: DIGEST_SCHEMA, // grammar-constrain the local path; the hosted path is prompted for it
  };
  let totalWritten = 0;
  let pending: PendingDigest[] = [];
  let existing = await loadDigests(db, opts.chatId);
  const at = (tier: number, blockIdx: number) =>
    existing.find((d) => d.tier === tier && d.blockIdx === blockIdx);

  // tier 0 — independent per-block digests.
  const blocks = chunk(older, cfg.blockSize);
  for (const [i, block] of blocks.entries()) {
    const first = block[0];
    const last = block[block.length - 1];
    if (!first || !last) continue;
    const seqStart = first.seq;
    const seqEnd = last.seq;
    const prev = at(0, i);
    const stale =
      !prev ||
      prev.seqStart !== seqStart ||
      prev.seqEnd !== seqEnd ||
      block.some((m) => m.editedAt !== null && m.editedAt > prev.createdAt);
    if (!stale) continue;
    const userPrompt = `Conversation block (messages ${seqStart}-${seqEnd}):\n\n${renderTranscript(block, charName, userName)}\n\nWrite the digest:`;
    const res = await deps.summarizer.summarize(TIER0_SYSTEM, userPrompt, summarizeOpts);
    const parsed = parseDigest(res.text);
    if (parsed.text.length === 0) continue;
    pending.push({ tier: 0, blockIdx: i, seqStart, seqEnd, summarizerModel: res.model, ...parsed });
  }
  if (pending.length > 0) {
    totalWritten += await embedAndUpsert(
      db,
      deps.embedder,
      opts.chatId,
      chat.ownerId,
      chat.characterVersionId,
      pending,
    );
    existing = await loadDigests(db, opts.chatId);
    pending = [];
  }

  // tiers 1..maxTier — consolidate `fanOut` lower-tier digests into one coarser digest. Deterministic
  // by blockIdx: parent block i covers children [i*fanOut, (i+1)*fanOut). A parent is stale if any
  // child was (re)written after it, or its covered span changed.
  for (let k = 0; k < cfg.maxTier; k++) {
    const tierK = existing.filter((d) => d.tier === k).sort((a, b) => a.blockIdx - b.blockIdx);
    const groups = Math.floor(tierK.length / cfg.fanOut);
    const priorConsolidations: string[] = [];
    for (let i = 0; i < groups; i++) {
      const children = tierK.slice(i * cfg.fanOut, (i + 1) * cfg.fanOut);
      const cFirst = children[0];
      const cLast = children[children.length - 1];
      if (!cFirst || !cLast) continue;
      const seqStart = cFirst.seqStart;
      const seqEnd = cLast.seqEnd;
      const parent = existing.find((d) => d.tier === k + 1 && d.blockIdx === i);
      const stale =
        !parent ||
        parent.seqStart !== seqStart ||
        parent.seqEnd !== seqEnd ||
        children.some((c) => c.createdAt > parent.createdAt);
      if (!stale) {
        if (parent) priorConsolidations.push(parent.text);
        continue;
      }
      const priorBlock =
        priorConsolidations.length > 0
          ? `Prior consolidated digests (do NOT repeat):\n${priorConsolidations.join("\n\n")}\n\n`
          : "";
      const childBlock = children.map((c) => c.text).join("\n\n");
      const userPrompt = `${priorBlock}New digests to merge (scenes ${seqStart}-${seqEnd}):\n\n${childBlock}\n\nWrite the consolidated digest:`;
      const res = await deps.summarizer.summarize(CONSOLIDATE_SYSTEM, userPrompt, summarizeOpts);
      const parsed = parseDigest(res.text);
      if (parsed.text.length === 0) continue;
      priorConsolidations.push(parsed.text);
      pending.push({
        tier: k + 1,
        blockIdx: i,
        seqStart,
        seqEnd,
        summarizerModel: res.model,
        ...parsed,
      });
    }
    if (pending.length > 0) {
      totalWritten += await embedAndUpsert(
        db,
        deps.embedder,
        opts.chatId,
        chat.ownerId,
        chat.characterVersionId,
        pending,
      );
      existing = await loadDigests(db, opts.chatId);
      pending = [];
    }
  }

  getLog().debug(
    { chatId: opts.chatId, tier0Blocks: blocks.length, written: totalWritten },
    "memory: digests generated",
  );
  return { written: totalWritten };
}

/**
 * (Re)build this chat's raw SEGMENTS — the verbatim half of the hybrid corpus search (docs/memory.md
 * §4). Same blockSize boundary as digests, but indexes EVERY complete block across the WHOLE chat (no
 * verbatimWindow cutoff — the cross-chat search tool wants all of it findable; the still-forming
 * trailing partial block is skipped to avoid per-turn re-embed churn). Embed-only (no summarizer →
 * cheap), so it runs for ALL chats regardless of memory.enabled. Idempotent/incremental: only
 * stale/missing blocks re-embed (span changed, or a contained message edited after the segment).
 */
export async function generateSegments(
  db: Db,
  deps: { embedder: Embedder },
  opts: { chatId: string; blockSize?: number | undefined },
): Promise<{ written: number }> {
  const blockSize = opts.blockSize ?? DEFAULTS.blockSize;
  const meta = await loadChatMeta(db, opts.chatId);
  if (!meta) return { written: 0 };
  const history = await loadHistory(db, opts.chatId);
  if (history.length === 0) return { written: 0 };

  const existing = new Map((await loadSegments(db, opts.chatId)).map((s) => [s.blockIdx, s]));
  // ALL blocks across the whole chat, INCLUDING the trailing partial (or a whole sub-blockSize chat),
  // so every chat is searchable — 100% corpus coverage (vs complete-blocks-only = 54%). The trailing
  // partial re-embeds as it grows (the seqEnd staleness check). Segments don't get the verbatimWindow
  // protection digests do — the corpus wants everything searchable; the tip just re-embeds on change.
  const blocks = chunk(history, blockSize);
  const pending: { blockIdx: number; seqStart: number; seqEnd: number; text: string }[] = [];
  for (const [i, block] of blocks.entries()) {
    const first = block[0];
    const last = block[block.length - 1];
    if (!first || !last) continue;
    const text = renderTranscript(block, meta.charName, meta.userName);
    if (text.trim().length === 0) continue; // skip a genuinely empty block
    const prev = existing.get(i);
    const stale =
      !prev ||
      prev.seqStart !== first.seq ||
      prev.seqEnd !== last.seq ||
      block.some((m) => m.editedAt !== null && m.editedAt > prev.createdAt);
    if (!stale) continue;
    pending.push({ blockIdx: i, seqStart: first.seq, seqEnd: last.seq, text });
  }
  if (pending.length === 0) return { written: 0 };

  const vecs = await deps.embedder.embedBatch(pending.map((p) => p.text));
  const createdAt = Date.now();
  let written = 0;
  for (const [i, p] of pending.entries()) {
    const vec = vecs[i];
    if (vec === undefined) continue;
    const fields = {
      seqStart: p.seqStart,
      seqEnd: p.seqEnd,
      text: p.text,
      model: deps.embedder.model,
      embedding: vec,
      // Rough token estimate (cost visibility); the embedder enforces the real BGE-M3 8192 cap.
      tokens: Math.round(p.text.length / 4),
      createdAt,
    };
    await db
      .insert(chatSegments)
      .values({
        id: newId(),
        chatId: opts.chatId,
        ownerId: meta.ownerId,
        characterVersionId: meta.characterVersionId,
        blockIdx: p.blockIdx,
        ...fields,
      })
      .onConflictDoUpdate({
        target: [chatSegments.chatId, chatSegments.blockIdx],
        set: fields,
      });
    written += 1;
  }
  getLog().debug({ chatId: opts.chatId, written }, "memory: segments generated");
  return { written };
}

// ── retrieval (cheap; on the reply critical path) ──────────────────────────────

function formatBlock(digests: DigestRow[]): string | null {
  const block = digests
    .map((d) => d.text.trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
  return block.length > 0 ? block : null;
}

/**
 * The formatted memory block for this chat's NEXT turn (the {{memory}} marker wraps it), or null.
 * mixA = all tier-0 chronological; tiered = the bridge (coarse high-tier for the distant past + the
 * uncovered tier-0 tail); mixB/mixC = vector (+keyword) retrieve the most relevant tier-0 digests,
 * mixC additionally cross-encoder reranks. Always presented chronologically by seqStart.
 */
export async function retrieveMemory(
  db: Db,
  deps: RetrieveMemoryDeps,
  opts: { chatId: string; params: MemoryConfig },
): Promise<string | null> {
  const cfg = resolveCfg(opts.params);
  if (!cfg.enabled || cfg.mode === "off") return null;
  const digests = await loadDigests(db, opts.chatId);
  if (digests.length === 0) return null;

  const bySeq = (a: DigestRow, b: DigestRow) => a.seqStart - b.seqStart;
  const tier0 = digests.filter((d) => d.tier === 0).sort(bySeq);

  if (cfg.mode === "mixA") return formatBlock(tier0);

  // tiered: every digest NOT covered by a higher-tier consolidation = coarse-old + fine-recent.
  if (cfg.mode === "tiered") {
    const covered = (d: DigestRow) =>
      digests.some((c) => c.tier > d.tier && c.seqStart <= d.seqStart && c.seqEnd >= d.seqEnd);
    return formatBlock(digests.filter((d) => !covered(d)).sort(bySeq));
  }

  // mixB / mixC — retrieve the most relevant tier-0 digests for the current scene.
  const query = await recentQueryText(db, opts.chatId, cfg.queryWindow);
  if (query.length === 0) return formatBlock(tier0);
  const qv = await deps.embedder.embed(query);
  // Recency nudge (reviewer #2): a mild boost toward more-recent digests, scaled by recencyBias
  // (0 = off). Inclusion stays on raw cosine vs minScore; recency only reorders the kept set.
  const maxSeqStart = Math.max(1, ...tier0.map((d) => d.seqStart));
  const recency = (d: DigestRow): number => cfg.recencyBias * (d.seqStart / maxSeqStart);
  const scored: { d: DigestRow; score: number }[] = [];
  for (const d of tier0) {
    if (d.embedding === null) continue;
    const score = cosineSim(qv, d.embedding);
    if (score >= cfg.minScore) scored.push({ d, score: score + recency(d) });
  }
  if (cfg.keywordMatch) {
    const qWords = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    // Match on any DISTINCTIVE token (≥4 chars) the keyword shares with the query — so a query
    // saying just "Gundam" hits the "Hi-Nu Gundam" keyword (rare-term recall, the gundam miss),
    // while short words ("the", "of") can't cause false positives (reviewer #3, #4).
    const kwMatches = (kw: string): boolean => {
      const words = kw.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      return words.some((w) => w.length >= 4 && qWords.has(w));
    };
    for (const d of tier0) {
      if (scored.some((s) => s.d === d)) continue;
      if (d.keywords.some(kwMatches)) scored.push({ d, score: cfg.minScore + recency(d) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  let chosen = scored.slice(0, cfg.retrieveK).map((s) => s.d);
  if (cfg.mode === "mixC" && chosen.length > 0) {
    const hits = await deps.reranker.rerank(
      query,
      chosen.map((d) => ({ id: `${d.tier}:${d.blockIdx}`, text: d.text })),
    );
    const order = new Map(hits.map((h, i) => [h.id, i]));
    chosen = [...chosen]
      .sort(
        (a, b) =>
          (order.get(`${a.tier}:${a.blockIdx}`) ?? Number.POSITIVE_INFINITY) -
          (order.get(`${b.tier}:${b.blockIdx}`) ?? Number.POSITIVE_INFINITY),
      )
      .slice(0, cfg.rerankTo);
  }
  if (chosen.length === 0) return null;
  return formatBlock(chosen.sort(bySeq));
}

async function recentQueryText(db: Db, chatId: string, window: number): Promise<string> {
  const hist = await loadHistory(db, chatId);
  return hist
    .slice(-window)
    .map((m) => m.content)
    .join("\n")
    .trim();
}
