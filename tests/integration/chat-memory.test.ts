import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { Db } from "../../src/db/client";
import { chatDigests, chatSegments, chats, messages } from "../../src/db/schema";
import { newId } from "../../src/server/domain/_shared/ids";
import { createChatService } from "../../src/server/domain/chat";
import { buildAssembleContext } from "../../src/server/domain/chat/context/assemble";
import { loadHistory, recentQueryText } from "../../src/server/domain/chat/memory/db";
import { generateDigests, generateSegments } from "../../src/server/domain/chat/memory/generate";
import { formatBlock, retrieveMemory } from "../../src/server/domain/chat/memory/retrieve";
import type { DigestRow } from "../../src/server/domain/chat/memory/types";
import { createPresetService } from "../../src/server/domain/preset";
import type { Embedder } from "../../src/server/embeddings/embedder";
import type { Reranker } from "../../src/server/embeddings/reranker";
import type { Summarizer } from "../../src/server/embeddings/summarizer";
import type { ChatTurnResult } from "../../src/server/providers/turn";
import { DEFAULT_PROMPT_CONFIG } from "../../src/shared/prompt-config";
import { freshDb } from "../support/db";

// Bag-of-words fake embedder: each word → a dim, summed + L2-normalized. Texts that SHARE words land
// near each other (cosine ∝ overlap) — exercises retrieval deterministically without a GPU.
const VOCAB = new Map<string, number>();
function bow(text: string): Float32Array {
  const v = new Float32Array(1024);
  for (const w of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    let d = VOCAB.get(w);
    if (d === undefined) {
      d = (VOCAB.size + 1) % 1024;
      VOCAB.set(w, d);
    }
    v[d] = (v[d] ?? 0) + 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}
const fakeEmbedder: Embedder = {
  model: "fake",
  embed: (t) => Promise.resolve(bow(t)),
  embedBatch: (ts) => Promise.resolve(ts.map(bow)),
};

// Deterministic fake summarizer: echo the prompt's content into a parseable structured digest (topic
// anchor + bullet + KEYWORDS), so the digest text contains the underlying message/child content and
// assertions can check what was captured.
const fakeSummarizer: Summarizer = {
  summarize: (_system, user) => {
    const flat = user.replace(/\s+/g, " ").trim();
    const kw = [...new Set(flat.toLowerCase().match(/[a-z]{4,}/g) ?? [])].slice(0, 12);
    return Promise.resolve({
      text: `[scene — test]\n- ${flat}\nKEYWORDS: ${kw.join(", ")}`,
      model: "fake-sum",
    });
  },
};
// Identity reranker (keeps input order) — enough to exercise the mixC path.
const fakeReranker: Reranker = {
  model: "fake",
  rerank: (_q, docs) => Promise.resolve(docs.map((d) => ({ id: d.id, score: 1 }))),
};

const genDeps = { embedder: fakeEmbedder, summarizer: fakeSummarizer };
const retDeps = { embedder: fakeEmbedder, reranker: fakeReranker };
const mem = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  blockSize: 2,
  verbatimWindow: 2,
  mode: "mixA" as const,
  ...extra,
});

// 8 messages: seq 0-5 age below verbatimWindow=2 (→ 3 blocks of 2); seq 6-7 stay in the live window.
const SCRIPT: { role: "user" | "assistant"; content: string }[] = [
  { role: "user", content: "good morning friend" },
  { role: "assistant", content: "I am Vermithrax an ancient dragon guarding the northern pass" },
  { role: "user", content: "tell me about your emeralds" },
  { role: "assistant", content: "I hoard emeralds deep in my cavern" },
  { role: "user", content: "and the village nearby" },
  { role: "assistant", content: "the village pays tribute every winter" },
  { role: "user", content: "what do you guard" },
  { role: "assistant", content: "the pass, always" },
];

async function insertMessages(
  db: Db,
  chatId: string,
  msgs: { role: "user" | "assistant"; content: string }[],
): Promise<void> {
  const now = Date.now();
  for (const [i, m] of msgs.entries()) {
    await db
      .insert(messages)
      .values({ id: newId(), chatId, seq: i, role: m.role, content: m.content, createdAt: now });
  }
}

async function makeChat(
  script: { role: "user" | "assistant"; content: string }[],
): Promise<{ db: Db; chatId: string }> {
  const db = await freshDb();
  const chat = createChatService(db, { embedder: fakeEmbedder });
  const { chatId } = await chat.create({
    username: "owner",
    title: "t",
    characterName: "Vermithrax",
    characterDescription: "a dragon",
  });
  await insertMessages(db, chatId, script);
  return { db, chatId };
}

async function digestsOf(db: Db, chatId: string) {
  return db.select().from(chatDigests).where(eq(chatDigests.chatId, chatId));
}

test("dormant: a chat with < one aged-out block writes no digests", async () => {
  const { db, chatId } = await makeChat(SCRIPT.slice(0, 3)); // only seq 0 ages out → < blockSize
  const { written } = await generateDigests(db, genDeps, { chatId, params: mem() });
  expect(written).toBe(0);
  expect(await digestsOf(db, chatId)).toHaveLength(0);
});

test("generates one tier-0 digest per aged-out block; the live window is never digested", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  const { written } = await generateDigests(db, genDeps, { chatId, params: mem() });
  expect(written).toBe(3); // blocks [0-1], [2-3], [4-5]
  const rows = await digestsOf(db, chatId);
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.tier === 0)).toBe(true);
  expect(Math.max(...rows.map((r) => r.seqEnd))).toBe(5); // seq 6-7 stay live, undigested
});

test("mixA retrieval injects all tier-0 digests chronologically, excluding the live window", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem() });
  const block = await retrieveMemory(db, retDeps, { chatId, params: mem() });
  expect(block).not.toBeNull();
  expect(block).toContain("Vermithrax"); // block [0-1]
  expect(block).toContain("emeralds"); // block [2-3]
  expect(block).toContain("village"); // block [4-5]
  expect(block).not.toContain("what do you guard"); // seq 6 — in the live window, not digested
});

test("a deep edit re-digests only the affected block (editedAt invalidation)", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem() });
  const before = await digestsOf(db, chatId);
  const block01Before = before.find((r) => r.seqStart === 0)?.createdAt ?? 0;

  // Edit a message inside block [2-3], with editedAt safely after the digest's createdAt.
  await db
    .update(messages)
    .set({ content: "tell me about your rubies", editedAt: Date.now() + 100_000 })
    .where(and(eq(messages.chatId, chatId), eq(messages.seq, 2)));

  await generateDigests(db, genDeps, { chatId, params: mem() });
  const block = await retrieveMemory(db, retDeps, { chatId, params: mem() });
  expect(block).toContain("rubies"); // the edited block was re-digested

  const after = await digestsOf(db, chatId);
  // block [0-1] was untouched → its digest createdAt is unchanged (no cascade).
  expect(after.find((r) => r.seqStart === 0)?.createdAt).toBe(block01Before);
});

test("tiered consolidation builds a tier-1 digest from filled tier-0 blocks", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  const params = mem({ mode: "tiered", fanOut: 2, maxTier: 1 });
  await generateDigests(db, genDeps, { chatId, params });
  const rows = await digestsOf(db, chatId);
  const tier1 = rows.filter((r) => r.tier === 1);
  expect(tier1).toHaveLength(1); // floor(3 tier-0 / fanOut 2) = 1
  expect(tier1[0]?.seqStart).toBe(0); // consolidates blocks [0-1] + [2-3] → spans seq 0-3

  const block = await retrieveMemory(db, retDeps, { chatId, params });
  expect(block).not.toBeNull();
  expect(block).toContain("village"); // tier-0 block [4-5] is uncovered → stays in the bridge
});

// #3: on a long-enough chat, mixC retrieves the COARSE (arc-level) consolidation for the distant
// past instead of granular tier-0 scenes — query-driven over the tiered bridge (coarse-old +
// fine-recent). This summarizer tags arc vs scene digests so the retrieved block is distinguishable.
const tierTagSummarizer: Summarizer = {
  summarize: (_system, user) => {
    const flat = user.replace(/\s+/g, " ").trim();
    const kw = [...new Set(flat.toLowerCase().match(/[a-z]{4,}/g) ?? [])].slice(0, 12);
    // The consolidate prompt asks to "merge" digests; the tier-0 prompt summarizes a single block.
    const tag = /merge/i.test(user) ? "COARSEARCDIGEST" : "FINESCENEDIGEST";
    return Promise.resolve({
      text: `[${tag}]\n- ${flat}\nKEYWORDS: ${kw.join(", ")}`,
      model: "fake-sum",
    });
  },
};

test("mixC retrieves the coarse arc digest for consolidated distant-past spans (not granular tier-0)", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  const params = mem({ mode: "mixC", fanOut: 2, maxTier: 1, minScore: 0 }); // minScore 0 → isolate pool composition from scoring

  // 3 tier-0 blocks → one tier-1 arc covering blocks [0-1]+[2-3] (seq 0-3); block [4-5] stays
  // uncovered tier-0. Tagged so an arc digest is identifiable in the retrieved block.
  await generateDigests(
    db,
    { embedder: fakeEmbedder, summarizer: tierTagSummarizer },
    { chatId, params },
  );
  const rows = await digestsOf(db, chatId);
  expect(rows.some((r) => r.tier === 1)).toBe(true); // sanity: consolidation happened

  // A query about the OLD, consolidated span (dragon/emeralds — blocks [0-1]/[2-3]).
  const block = await retrieveMemory(db, retDeps, {
    chatId,
    params,
    pendingUserText: "remind me about the dragon and the emeralds",
  });

  expect(block).not.toBeNull();
  // The distant past is retrieved as its ARC digest — impossible while mixC's pool is tier-0 only.
  expect(block).toContain("COARSEARCDIGEST");
});

// ── #1 regression: the retrieval query must reflect the message being answered ────────────────
// `send` assembles the prompt — which runs retrieveMemory — BEFORE committing the user turn. If the
// retrieval query is built from committed rows alone, it sees the PREVIOUS exchange, never the
// just-sent message, so a topic-shift turn retrieves against the wrong text. This drives the real
// send path and captures the text handed to the embedder for retrieval; it must contain the
// just-sent content. (Minimal canned turn — the runner boundary is faked; test files are jscpd-exempt.)
const cannedTurn = (reply: string): ChatTurnResult => ({
  reply,
  sessionId: "sess-1",
  stopReason: "end_turn",
  terminalReason: "completed",
  finishReason: "stop",
  ttftMs: 1,
  durationApiMs: null,
  apiErrorStatus: null,
  numTurns: 1,
  usage: {
    model: "fake",
    tokensIn: 1,
    tokensOut: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    reasoningTokens: null,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    webSearchRequests: 0,
    costUsd: 0,
    costDetails: null,
    isByok: null,
  },
  events: [],
  rateLimit: null,
});

test("send embeds the just-sent user message as the memory retrieval query (regression: assemble-before-insert)", async () => {
  const db = await freshDb();

  // Recording embedder: capture the single-embed RETRIEVAL queries. Digest/segment generation uses
  // embedBatch, so embed() is the retrieval path alone; bow() keeps everything in one vector space.
  const retrievalQueries: string[] = [];
  const recordingEmbedder: Embedder = {
    model: "fake",
    embed: (t) => {
      retrievalQueries.push(t);
      return Promise.resolve(bow(t));
    },
    embedBatch: (ts) => Promise.resolve(ts.map(bow)),
  };

  const chat = createChatService(db, {
    runTurn: () => Promise.resolve(cannedTurn("ok")),
    embedder: recordingEmbedder,
    summarizer: fakeSummarizer,
    reranker: fakeReranker,
  });
  const { chatId } = await chat.create({
    username: "owner",
    title: "t",
    characterName: "Vermithrax",
    characterDescription: "a dragon",
  });

  // Aged-out history + real digests, so retrieveMemory has candidates and reaches the query embed.
  await insertMessages(db, chatId, SCRIPT); // seq 0..7
  await generateDigests(db, genDeps, { chatId, params: mem({ mode: "mixC" }) });

  // Pin a memory-enabled preset. DEFAULT_PROMPT_CONFIG already carries the {{memory}} marker; only
  // params.memory.enabled + a query-driven mode (mixC) need turning on for retrieval to run.
  const preset = await createPresetService(db).create({
    username: "owner",
    name: "mem",
    kind: "chat",
    config: { ...DEFAULT_PROMPT_CONFIG, params: { memory: mem({ mode: "mixC" }) } },
  });
  await db
    .update(chats)
    .set({ presetVersionId: preset.currentVersionId })
    .where(eq(chats.id, chatId));

  // Act: a topic-shift turn carrying a nonce that appears in NO prior message.
  const nonce = "zephyrbrasskey";
  retrievalQueries.length = 0; // discard the embeds from digest generation above
  const result = await chat.send({
    username: "owner",
    chatId,
    expectedSeq: 7,
    content: `wait what about the ${nonce}`,
  });

  expect(result.status).toBe("ok");
  // retrieveMemory always embeds (history is non-empty either way) — the regression is in the
  // CONTENT: the query must include the message being answered, not just the prior exchange.
  expect(retrievalQueries.length).toBeGreaterThan(0);
  expect(retrievalQueries.some((q) => q.includes(nonce))).toBe(true);
});

// #4: background digest generation is fire-and-forget (it outlives the send lock), so two rapid
// sends can launch overlapping generateDigests for the same chat — both reading the same staleness
// snapshot and both calling the summarizer (double spend). A non-blocking per-chat in-flight guard
// must make the second invocation skip rather than run concurrently.
test("concurrent digest generations for the same chat skip the duplicate (no double summarize)", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  let calls = 0;
  const countingSummarizer: Summarizer = {
    summarize: (system, user, opts) => {
      calls += 1;
      return fakeSummarizer.summarize(system, user, opts);
    },
  };
  const deps = { embedder: fakeEmbedder, summarizer: countingSummarizer };

  const [a, b] = await Promise.all([
    generateDigests(db, deps, { chatId, params: mem() }),
    generateDigests(db, deps, { chatId, params: mem() }),
  ]);

  // One invocation does the work (3 aged-out blocks → 3 summarize calls); the other sees it in
  // flight and skips. Without the guard both run: 6 summarize calls and written [3, 3].
  expect([a.written, b.written].sort((x, y) => x - y)).toEqual([0, 3]);
  expect(calls).toBe(3);
});

// #2: when the block grid SHRINKS (blockSize grows, or a message is edited to empty), the trailing
// high-index digest/segment rows no longer map to any current block. Regeneration must prune them,
// or stale digests are injected into prompts / searched forever.
test("regenerating after a blockSize increase prunes orphaned high-index tier-0 digests", async () => {
  const { db, chatId } = await makeChat(SCRIPT);

  // blockSize 2: older (seq 0-5, verbatimWindow 2) chunks into 3 blocks → tier-0 idx 0, 1, 2.
  await generateDigests(db, genDeps, { chatId, params: mem({ blockSize: 2 }) });
  const before = (await digestsOf(db, chatId)).filter((r) => r.tier === 0).map((r) => r.blockIdx);
  expect(before.sort((a, b) => a - b)).toEqual([0, 1, 2]);

  // blockSize 2→3: the same 6 aged messages now chunk into 2 blocks (idx 0, 1) → idx 2 orphans.
  await generateDigests(db, genDeps, { chatId, params: mem({ blockSize: 3 }) });

  const after = (await digestsOf(db, chatId)).filter((r) => r.tier === 0).map((r) => r.blockIdx);
  expect(after.sort((a, b) => a - b)).toEqual([0, 1]); // idx 2 pruned, not left as a ghost
});

test("editing older messages to empty shrinks the grid and prunes the now-orphaned tail digest", async () => {
  const { db, chatId } = await makeChat(SCRIPT);

  // blockSize 2, older = seq 0-5 (6 msgs) → tier-0 idx 0, 1, 2.
  await generateDigests(db, genDeps, { chatId, params: mem({ blockSize: 2 }) });
  expect((await digestsOf(db, chatId)).filter((r) => r.tier === 0)).toHaveLength(3);

  // Empty two older messages — loadHistory drops empty content, so `older` falls 6 → 4 real
  // messages → 2 blocks (idx 0, 1). The trailing idx 2 digest now maps to no block.
  await db
    .update(messages)
    .set({ content: "  ", editedAt: Date.now() + 100_000 })
    .where(and(eq(messages.chatId, chatId), eq(messages.seq, 0)));
  await db
    .update(messages)
    .set({ content: "", editedAt: Date.now() + 100_000 })
    .where(and(eq(messages.chatId, chatId), eq(messages.seq, 1)));

  await generateDigests(db, genDeps, { chatId, params: mem({ blockSize: 2 }) });

  const after = (await digestsOf(db, chatId)).filter((r) => r.tier === 0).map((r) => r.blockIdx);
  expect(after.sort((a, b) => a - b)).toEqual([0, 1]); // the second named #2 trigger, same prune path
});

test("regenerating segments after a blockSize increase prunes orphaned high-index segments", async () => {
  const { db, chatId } = await makeChat(SCRIPT);

  // blockSize 2: all 8 messages → 4 segment blocks (idx 0-3).
  await generateSegments(db, { embedder: fakeEmbedder }, { chatId, blockSize: 2 });
  const before = (await db.select().from(chatSegments).where(eq(chatSegments.chatId, chatId))).map(
    (r) => r.blockIdx,
  );
  expect(before.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

  // blockSize 2→4: 8 messages → 2 blocks (idx 0, 1) → idx 2, 3 orphan.
  await generateSegments(db, { embedder: fakeEmbedder }, { chatId, blockSize: 4 });

  const after = (await db.select().from(chatSegments).where(eq(chatSegments.chatId, chatId))).map(
    (r) => r.blockIdx,
  );
  expect(after.sort((a, b) => a - b)).toEqual([0, 1]); // idx 2, 3 pruned
});

// ── retrieveMemory sad paths ─────────────────────────────────────────────────

test("retrieveMemory: a disabled config returns null (never touches the DB)", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem() });
  expect(await retrieveMemory(db, retDeps, { chatId, params: mem({ enabled: false }) })).toBeNull();
});

test("retrieveMemory: mode 'off' returns null even with digests present", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem() });
  expect(await retrieveMemory(db, retDeps, { chatId, params: mem({ mode: "off" }) })).toBeNull();
});

test("retrieveMemory: a chat with no digests yet returns null", async () => {
  const { db, chatId } = await makeChat(SCRIPT); // messages exist, but generate never ran
  expect(await retrieveMemory(db, retDeps, { chatId, params: mem({ mode: "mixC" }) })).toBeNull();
});

test("retrieveMemory: an empty query falls back to the full bridge, not null", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem({ mode: "mixC" }) });

  // Force an empty retrieval query: no committed messages and no in-flight turn.
  await db.delete(messages).where(eq(messages.chatId, chatId));
  const block = await retrieveMemory(db, retDeps, { chatId, params: mem({ mode: "mixC" }) });

  expect(block).not.toBeNull(); // fell back to the bridge rather than returning null
  expect(block).toContain("village"); // a tier-0 digest is present
});

test("retrieveMemory: a digest with a null embedding is skipped by the vector path", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem({ mode: "mixC" }) });

  // Null out the [4-5] "village" digest's embedding; keyword path off so only cosine selection runs.
  await db
    .update(chatDigests)
    .set({ embedding: null })
    .where(and(eq(chatDigests.chatId, chatId), eq(chatDigests.seqStart, 4)));

  const block = await retrieveMemory(db, retDeps, {
    chatId,
    params: mem({ mode: "mixC", keywordMatch: false, minScore: 0 }),
    pendingUserText: "tell me about the village tribute",
  });

  expect(block).not.toBeNull();
  expect(block).not.toContain("village"); // the null-embedding digest was skipped
  expect(block).toContain("emeralds"); // other digests still retrieved
});

test("formatBlock: all-empty digests → null; mixed → joins only the non-empty texts", () => {
  expect(formatBlock([])).toBeNull();
  expect(formatBlock([{ text: "   " }] as unknown as DigestRow[])).toBeNull();
  expect(formatBlock([{ text: "a" }, { text: "" }, { text: "b" }] as unknown as DigestRow[])).toBe(
    "a\n\nb",
  );
});

// ── send/assemble memory gating matrix ───────────────────────────────────────
// The {{memory}} gate is `memCfg.enabled === true && hasMemoryMarker`, evaluated in buildAssembleContext
// (inline for read/swipe/compaction) and deferred-then-recomputed in send. These pin every arm.

const memOn = { ...DEFAULT_PROMPT_CONFIG, params: { memory: mem({ mode: "mixA" }) } };
const memParamsOff = {
  ...DEFAULT_PROMPT_CONFIG,
  params: { memory: mem({ mode: "mixA", enabled: false }) },
};
const memMarkerOff = {
  ...DEFAULT_PROMPT_CONFIG,
  sections: DEFAULT_PROMPT_CONFIG.sections.map((s) =>
    s.type === "marker" && s.marker === "memory" ? { ...s, enabled: false } : s,
  ),
  params: { memory: mem({ mode: "mixA" }) },
};

async function pinPreset(db: Db, chatId: string, config: unknown) {
  const preset = await createPresetService(db).create({
    username: "owner",
    name: "p",
    kind: "chat",
    // biome-ignore lint/suspicious/noExplicitAny: test pins an arbitrary prompt-config blob
    config: config as any,
  });
  await db
    .update(chats)
    .set({ presetVersionId: preset.currentVersionId })
    .where(eq(chats.id, chatId));
  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  if (!row) throw new Error("chat row missing after pin");
  return row;
}

async function pollUntil<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("pollUntil: condition not met within timeout");
}

test("gate ON (enabled + marker + digests): buildAssembleContext retrieves a memory block", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem({ mode: "mixC" }) });
  const chat = await pinPreset(db, chatId, memOn);

  const ctx = await buildAssembleContext(db, fakeEmbedder, fakeReranker, chat);
  expect(ctx.memory).not.toBeNull();
});

test("send defers memory: buildAssembleContext with deferMemory returns null (send recomputes later)", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem({ mode: "mixC" }) });
  const chat = await pinPreset(db, chatId, memOn);

  const ctx = await buildAssembleContext(db, fakeEmbedder, fakeReranker, chat, {
    deferMemory: true,
  });
  expect(ctx.memory).toBeNull();
});

test("gate OFF (params disabled): no retrieval even with the marker present + digests", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem({ mode: "mixC" }) });
  const chat = await pinPreset(db, chatId, memParamsOff);

  const ctx = await buildAssembleContext(db, fakeEmbedder, fakeReranker, chat);
  expect(ctx.memory).toBeNull();
});

test("gate OFF (marker disabled): no retrieval even with memory enabled in params + digests", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem({ mode: "mixC" }) });
  const chat = await pinPreset(db, chatId, memMarkerOff);

  const ctx = await buildAssembleContext(db, fakeEmbedder, fakeReranker, chat);
  expect(ctx.memory).toBeNull();
});

test("a send with memory enabled fires background digest generation (digests materialize)", async () => {
  const db = await freshDb();
  const chat = createChatService(db, {
    runTurn: () => Promise.resolve(cannedTurn("ok")),
    embedder: fakeEmbedder,
    summarizer: fakeSummarizer,
    reranker: fakeReranker,
  });
  const { chatId } = await chat.create({
    username: "owner",
    title: "t",
    characterName: "Vermithrax",
    characterDescription: "a dragon",
  });
  await insertMessages(db, chatId, SCRIPT); // seq 0-7
  await pinPreset(db, chatId, memOn);

  await chat.send({ username: "owner", chatId, expectedSeq: 7, content: "another turn" });

  // generateDigests is fire-and-forget (void) — poll until it lands rather than asserting synchronously.
  const rows = await pollUntil(
    () => digestsOf(db, chatId),
    (r) => r.length > 0,
  );
  expect(rows.length).toBeGreaterThan(0);
});

// ── recentQueryText / loadHistory filtering ──────────────────────────────────
// loadHistory is the single canon reader; recentQueryText builds the retrieval query from it. The
// system-role + empty-content filter here is exactly what kept the #1 fix from leaking author's
// notes / blank rows into the query.

async function blankChat(): Promise<{ db: Db; chatId: string }> {
  const db = await freshDb();
  const chat = createChatService(db, { embedder: fakeEmbedder });
  const { chatId } = await chat.create({
    username: "owner",
    title: "t",
    characterName: "Vermithrax",
    characterDescription: "a dragon",
  });
  return { db, chatId };
}

test("loadHistory excludes system-role rows and empty/whitespace content", async () => {
  const { db, chatId } = await blankChat();
  const now = Date.now();
  const rows = [
    { seq: 0, role: "user", content: "alpha" },
    { seq: 1, role: "system", content: "author note — excluded" },
    { seq: 2, role: "assistant", content: "" },
    { seq: 3, role: "assistant", content: "   " },
    { seq: 4, role: "user", content: "bravo" },
  ] as const;
  for (const r of rows)
    await db.insert(messages).values({ id: newId(), chatId, ...r, createdAt: now });

  const hist = await loadHistory(db, chatId);
  expect(hist.map((m) => m.content)).toEqual(["alpha", "bravo"]);
  expect(hist.some((m) => m.role === "system")).toBe(false);
});

test("recentQueryText: the window slices the last N messages, joined by newline", async () => {
  const { db, chatId } = await makeChat([
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ]);
  expect(await recentQueryText(db, chatId, 2)).toBe("two\nthree");
  expect(await recentQueryText(db, chatId, 1)).toBe("three");
});

test("recentQueryText: a non-empty pendingUserText is appended inside the window", async () => {
  const { db, chatId } = await makeChat([
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ]);
  expect(await recentQueryText(db, chatId, 2, "four")).toBe("three\nfour");
});

test("recentQueryText: an empty/whitespace pendingUserText is ignored", async () => {
  const { db, chatId } = await makeChat([
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ]);
  expect(await recentQueryText(db, chatId, 2, "   ")).toBe("two\nthree");
});

test("recentQueryText: a system row inside the window never pollutes the query (#1 filter)", async () => {
  const { db, chatId } = await blankChat();
  const now = Date.now();
  const rows = [
    { seq: 0, role: "user", content: "real one" },
    { seq: 1, role: "system", content: "SYSTEMNOTE" },
    { seq: 2, role: "user", content: "real two" },
  ] as const;
  for (const r of rows)
    await db.insert(messages).values({ id: newId(), chatId, ...r, createdAt: now });

  const q = await recentQueryText(db, chatId, 2);
  expect(q).toBe("real one\nreal two");
  expect(q).not.toContain("SYSTEMNOTE");
});

// ── consolidation: multi-tier + the vertical staleness cascade ────────────────
// 10 messages → seq 0-7 age out (4 tier-0 blocks of 2); seq 8-9 stay live. fanOut 2, maxTier 2 →
// 2 tier-1 + 1 tier-2. Distinctive per-message tokens let us trace an edit propagating UP the tiers.
const LONG_SCRIPT: { role: "user" | "assistant"; content: string }[] = [
  { role: "user", content: "alpha apple" },
  { role: "assistant", content: "alpha apricot" },
  { role: "user", content: "bravo banana" },
  { role: "assistant", content: "bravo blueberry" },
  { role: "user", content: "charlie cherry" },
  { role: "assistant", content: "charlie coconut" },
  { role: "user", content: "delta date" },
  { role: "assistant", content: "delta dragonfruit" },
  { role: "user", content: "echo eggplant" },
  { role: "assistant", content: "echo endive" },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("multi-tier: maxTier 2 consolidates tier-0 → tier-1 → tier-2", async () => {
  const { db, chatId } = await makeChat(LONG_SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem({ fanOut: 2, maxTier: 2 }) });

  const rows = await digestsOf(db, chatId);
  expect(rows.filter((r) => r.tier === 0)).toHaveLength(4);
  expect(rows.filter((r) => r.tier === 1)).toHaveLength(2);
  expect(rows.filter((r) => r.tier === 2)).toHaveLength(1);
  const t2 = rows.find((r) => r.tier === 2);
  expect(t2?.seqStart).toBe(0);
  expect(t2?.seqEnd).toBe(7); // the tier-2 arc spans all four aged blocks
});

test("vertical cascade: a deep edit re-consolidates up through tier-2 in ONE generate pass", async () => {
  const { db, chatId } = await makeChat(LONG_SCRIPT);
  const params = mem({ fanOut: 2, maxTier: 2 });
  await generateDigests(db, genDeps, { chatId, params });
  expect((await digestsOf(db, chatId)).find((r) => r.tier === 2)?.text).not.toContain("rubies");

  // Edit a message in tier-0 block [0-1] (covered by tier-1 idx 0, covered by tier-2 idx 0).
  await db
    .update(messages)
    .set({ content: "rubies in the deep", editedAt: Date.now() + 100_000 })
    .where(and(eq(messages.chatId, chatId), eq(messages.seq, 0)));
  await sleep(5); // ensure the re-digest's createdAt advances past the old parents' (prod = turn-spaced)

  await generateDigests(db, genDeps, { chatId, params }); // ONE pass — the cascade must ripple all tiers

  const rows = await digestsOf(db, chatId);
  expect(rows.find((r) => r.tier === 0 && r.seqStart === 0)?.text).toContain("rubies"); // tier-0 re-digested
  expect(rows.find((r) => r.tier === 1 && r.seqStart === 0)?.text).toContain("rubies"); // tier-1 cascaded
  expect(rows.find((r) => r.tier === 2)?.text).toContain("rubies"); // tier-2 cascaded — single pass
});

// ── retrieval scoring: mixB / minScore / retrieveK ───────────────────────────
// Digests are INSERTED directly with crafted text so cosine (bow = term-overlap) is fully
// controllable — the fake summarizer's boilerplate keywords would muddy score-threshold assertions.

async function chatForDigests(): Promise<{
  db: Db;
  chatId: string;
  ownerId: string;
  cvId: string;
}> {
  const { db, chatId } = await blankChat();
  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  if (!row) throw new Error("chat row missing");
  return { db, chatId, ownerId: row.ownerId, cvId: row.characterVersionId };
}

async function insertDigest(
  db: Db,
  chatId: string,
  ownerId: string,
  cvId: string,
  d: {
    tier?: number;
    blockIdx: number;
    seqStart: number;
    seqEnd: number;
    text: string;
    keywords?: string[];
    embedding?: Float32Array | null;
  },
): Promise<void> {
  await db.insert(chatDigests).values({
    id: newId(),
    chatId,
    ownerId,
    characterVersionId: cvId,
    tier: d.tier ?? 0,
    blockIdx: d.blockIdx,
    seqStart: d.seqStart,
    seqEnd: d.seqEnd,
    text: d.text,
    keywords: d.keywords ?? [],
    model: "fake",
    embedding: d.embedding === undefined ? bow(d.text) : d.embedding,
    createdAt: Date.now(),
  });
}

test("mixB: vector retrieve returns matching digests, presented chronologically (no rerank)", async () => {
  const { db, chatId, ownerId, cvId } = await chatForDigests();
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 1,
    seqStart: 4,
    seqEnd: 5,
    text: "summit ridge later",
  });
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "summit ridge earlier",
  });

  const block = await retrieveMemory(db, retDeps, {
    chatId,
    params: mem({ mode: "mixB", keywordMatch: false, minScore: 0 }),
    pendingUserText: "summit ridge",
  });

  expect(block).not.toBeNull();
  expect((block ?? "").indexOf("earlier")).toBeLessThan((block ?? "").indexOf("later")); // seq order
});

test("minScore: a below-threshold digest is excluded; an above-threshold one is kept", async () => {
  const { db, chatId, ownerId, cvId } = await chatForDigests();
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "zebra summit ridge",
  }); // cosine 1
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 1,
    seqStart: 2,
    seqEnd: 3,
    text: "yak meadow plain",
  }); // cosine 0

  const block = await retrieveMemory(db, retDeps, {
    chatId,
    params: mem({ mode: "mixB", keywordMatch: false, minScore: 0.5 }),
    pendingUserText: "zebra summit ridge",
  });

  expect(block).toContain("summit");
  expect(block).not.toContain("yak");
});

test("retrieveK: only the top-K candidates by cosine are kept", async () => {
  const { db, chatId, ownerId, cvId } = await chatForDigests();
  // "match" repetition drives cosine; the unique token identifies each. Decreasing weight → rank.
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "match match match zero",
  });
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 1,
    seqStart: 2,
    seqEnd: 3,
    text: "match match one",
  });
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 2,
    seqStart: 4,
    seqEnd: 5,
    text: "match two",
  });
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 3,
    seqStart: 6,
    seqEnd: 7,
    text: "match three three",
  });

  const block = await retrieveMemory(db, retDeps, {
    chatId,
    params: mem({ mode: "mixB", keywordMatch: false, minScore: 0, retrieveK: 2 }),
    pendingUserText: "match",
  });

  expect(block).toContain("zero"); // top-1
  expect(block).toContain("one"); // top-2
  expect(block).not.toContain("two"); // cut by retrieveK
  expect(block).not.toContain("three");
});

// ── retrieval scoring: keyword recall / rerank reorder / recency / chronological order ──

test("keyword recall: a ≥4-char query token matching a digest keyword pulls it in below cosine", async () => {
  const { db, chatId, ownerId, cvId } = await chatForDigests();
  // Cosine ~0 vs the query, but a keyword matches → keyword path must still surface it.
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "totally unrelated content xyz",
    keywords: ["gundam"],
  });

  const block = await retrieveMemory(db, retDeps, {
    chatId,
    params: mem({ mode: "mixB", keywordMatch: true, minScore: 0.5 }),
    pendingUserText: "what about the gundam",
  });

  expect(block).toContain("unrelated"); // pulled in by the "gundam" keyword despite low cosine
});

test("keyword no-false-positive: a shared <4-char token does NOT match", async () => {
  const { db, chatId, ownerId, cvId } = await chatForDigests();
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "feline beast prowls",
    keywords: ["cat"], // 3 chars — must not trigger on the query's "cat"
  });

  const block = await retrieveMemory(db, retDeps, {
    chatId,
    params: mem({ mode: "mixB", keywordMatch: true, minScore: 0.5 }),
    pendingUserText: "cat",
  });

  expect(block).toBeNull(); // "cat" too short to match; cosine too low → nothing retrieved
});

test("mixC rerank: the reranker's order wins and rerankTo slices the kept set", async () => {
  const { db, chatId, ownerId, cvId } = await chatForDigests();
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "common WINNER alpha",
  });
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 1,
    seqStart: 2,
    seqEnd: 3,
    text: "common loser beta",
  });
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 2,
    seqStart: 4,
    seqEnd: 5,
    text: "common WINNER gamma",
  });

  // Reranker promotes docs containing WINNER; returns them in that order.
  const winnerReranker: Reranker = {
    model: "fake",
    rerank: (_q, docs) =>
      Promise.resolve(
        [...docs]
          .sort((a, b) => (b.text.includes("WINNER") ? 1 : 0) - (a.text.includes("WINNER") ? 1 : 0))
          .map((d) => ({ id: d.id, score: 1 })),
      ),
  };

  const block = await retrieveMemory(
    db,
    { embedder: fakeEmbedder, reranker: winnerReranker },
    {
      chatId,
      params: mem({ mode: "mixC", keywordMatch: false, minScore: 0, rerankTo: 2 }),
      pendingUserText: "common",
    },
  );

  expect(block).toContain("alpha"); // WINNER, kept
  expect(block).toContain("gamma"); // WINNER, kept
  expect(block).not.toContain("loser"); // demoted by rerank, then cut by rerankTo
});

test("recencyBias reorders the kept set toward recent (changes which survive retrieveK)", async () => {
  const { db, chatId, ownerId, cvId } = await chatForDigests();
  // Equal cosine to "common"; recency breaks the tie when retrieveK cuts.
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "common zero",
  });
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 1,
    seqStart: 2,
    seqEnd: 3,
    text: "common one",
  });
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 2,
    seqStart: 4,
    seqEnd: 5,
    text: "common two",
  });

  const block = await retrieveMemory(db, retDeps, {
    chatId,
    params: mem({ mode: "mixB", keywordMatch: false, minScore: 0, retrieveK: 2, recencyBias: 1 }),
    pendingUserText: "common",
  });

  expect(block).toContain("two"); // most recent — kept
  expect(block).not.toContain("zero"); // oldest — dropped in favor of the recent two
});

test("chronological final order: output is always seq-ascending even when rerank reverses it", async () => {
  const { db, chatId, ownerId, cvId } = await chatForDigests();
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "common earlytoken",
  });
  await insertDigest(db, chatId, ownerId, cvId, {
    blockIdx: 1,
    seqStart: 4,
    seqEnd: 5,
    text: "common latetoken",
  });

  const reverseReranker: Reranker = {
    model: "fake",
    rerank: (_q, docs) => Promise.resolve([...docs].reverse().map((d) => ({ id: d.id, score: 1 }))),
  };

  const block = await retrieveMemory(
    db,
    { embedder: fakeEmbedder, reranker: reverseReranker },
    {
      chatId,
      params: mem({ mode: "mixC", keywordMatch: false, minScore: 0 }),
      pendingUserText: "common",
    },
  );

  expect((block ?? "").indexOf("earlytoken")).toBeLessThan((block ?? "").indexOf("latetoken"));
});

// ── generation: idempotency, prune cascade, partial block, gates ─────────────

test("idempotent: a second generate with no changes writes nothing (cost is bounded)", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  expect((await generateDigests(db, genDeps, { chatId, params: mem() })).written).toBe(3);
  expect((await generateDigests(db, genDeps, { chatId, params: mem() })).written).toBe(0);
});

test("prune cascade: shrinking the grid drops orphaned tier-0, tier-1, AND empties a now-0-group tier", async () => {
  const { db, chatId } = await makeChat(LONG_SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem({ fanOut: 2, maxTier: 2 }) });
  let rows = await digestsOf(db, chatId);
  expect(rows.filter((r) => r.tier === 1)).toHaveLength(2);
  expect(rows.filter((r) => r.tier === 2)).toHaveLength(1);

  // blockSize 2→4: 8 aged msgs → 2 tier-0 → 1 tier-1 group → 0 tier-2 groups.
  await generateDigests(db, genDeps, {
    chatId,
    params: mem({ blockSize: 4, fanOut: 2, maxTier: 2 }),
  });

  rows = await digestsOf(db, chatId);
  expect(
    rows
      .filter((r) => r.tier === 0)
      .map((r) => r.blockIdx)
      .sort(),
  ).toEqual([0, 1]);
  expect(rows.filter((r) => r.tier === 1).map((r) => r.blockIdx)).toEqual([0]); // idx 1 pruned
  expect(rows.filter((r) => r.tier === 2)).toHaveLength(0); // 0 groups → whole tier pruned
});

test("tiers-above prune: lowering maxTier drops the now-too-high consolidation tier", async () => {
  const { db, chatId } = await makeChat(LONG_SCRIPT);
  await generateDigests(db, genDeps, { chatId, params: mem({ fanOut: 2, maxTier: 2 }) });
  expect((await digestsOf(db, chatId)).filter((r) => r.tier === 2)).toHaveLength(1);

  await generateDigests(db, genDeps, { chatId, params: mem({ fanOut: 2, maxTier: 1 }) });

  const rows = await digestsOf(db, chatId);
  expect(rows.filter((r) => r.tier === 2)).toHaveLength(0); // pruned by pruneDigestTiersAbove
  expect(rows.filter((r) => r.tier === 1)).toHaveLength(2); // tier 1 survives
});

test("partial trailing block: an aged block shorter than blockSize is still digested", async () => {
  const { db, chatId } = await makeChat(SCRIPT); // 8 msgs, seq 0-7
  // verbatimWindow 1 → only seq 7 live; older = seq 0-6 (7 msgs). blockSize 3 → [0-2],[3-5],[6] (partial).
  await generateDigests(db, genDeps, { chatId, params: mem({ blockSize: 3, verbatimWindow: 1 }) });

  const tier0 = (await digestsOf(db, chatId))
    .filter((r) => r.tier === 0)
    .sort((a, b) => a.seqStart - b.seqStart);
  expect(tier0).toHaveLength(3);
  expect(tier0[2]?.seqStart).toBe(6);
  expect(tier0[2]?.seqEnd).toBe(6); // the lone trailing message is its own (partial) block
});

test("generate gates: disabled / mode off / empty history / missing chat all no-op", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  expect(
    (await generateDigests(db, genDeps, { chatId, params: mem({ enabled: false }) })).written,
  ).toBe(0);
  expect(
    (await generateDigests(db, genDeps, { chatId, params: mem({ mode: "off" }) })).written,
  ).toBe(0);
  expect(await digestsOf(db, chatId)).toHaveLength(0); // neither wrote anything

  const { db: emptyDb, chatId: emptyChat } = await blankChat(); // no messages
  expect(
    (await generateDigests(emptyDb, genDeps, { chatId: emptyChat, params: mem() })).written,
  ).toBe(0);

  expect(
    (await generateDigests(db, genDeps, { chatId: "does-not-exist", params: mem() })).written,
  ).toBe(0);
});

// ── generateSegments: staleness, in-flight guard, trailing-partial regrow ─────

const segmentsOf = (db: Db, chatId: string) =>
  db.select().from(chatSegments).where(eq(chatSegments.chatId, chatId));

test("generateSegments re-embeds a block when a contained message is edited", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  await generateSegments(db, { embedder: fakeEmbedder }, { chatId, blockSize: 2 });
  expect((await segmentsOf(db, chatId)).find((s) => s.blockIdx === 0)?.text).toContain(
    "good morning",
  );

  await db
    .update(messages)
    .set({ content: "edited opener xyz", editedAt: Date.now() + 100_000 })
    .where(and(eq(messages.chatId, chatId), eq(messages.seq, 0)));
  const { written } = await generateSegments(
    db,
    { embedder: fakeEmbedder },
    { chatId, blockSize: 2 },
  );

  expect(written).toBeGreaterThanOrEqual(1);
  expect((await segmentsOf(db, chatId)).find((s) => s.blockIdx === 0)?.text).toContain(
    "edited opener xyz",
  );
});

test("concurrent generateSegments for the same chat skip the duplicate (in-flight guard)", async () => {
  const { db, chatId } = await makeChat(SCRIPT); // 8 msgs / 2 → 4 segment blocks
  let batchCalls = 0;
  const counting: Embedder = {
    model: "fake",
    embed: (t) => Promise.resolve(bow(t)),
    embedBatch: (ts) => {
      batchCalls += 1;
      return Promise.resolve(ts.map(bow));
    },
  };

  const [a, b] = await Promise.all([
    generateSegments(db, { embedder: counting }, { chatId, blockSize: 2 }),
    generateSegments(db, { embedder: counting }, { chatId, blockSize: 2 }),
  ]);

  expect([a.written, b.written].sort((x, y) => x - y)).toEqual([0, 4]);
  expect(batchCalls).toBe(1); // the duplicate skipped before embedding
});

test("a trailing partial segment re-embeds as the chat grows (seqEnd staleness)", async () => {
  const { db, chatId } = await makeChat(SCRIPT.slice(0, 5)); // 5 msgs → [0-1],[2-3],[4]
  await generateSegments(db, { embedder: fakeEmbedder }, { chatId, blockSize: 2 });
  const tail = (await segmentsOf(db, chatId)).find((s) => s.blockIdx === 2);
  expect(tail?.seqStart).toBe(4);
  expect(tail?.seqEnd).toBe(4); // a lone partial block

  await db.insert(messages).values({
    id: newId(),
    chatId,
    seq: 5,
    role: "assistant",
    content: "the village pays tribute",
    createdAt: Date.now(),
  });
  const { written } = await generateSegments(
    db,
    { embedder: fakeEmbedder },
    { chatId, blockSize: 2 },
  );

  expect(written).toBe(1); // only the trailing block (seqEnd 4→5) re-embeds
  expect((await segmentsOf(db, chatId)).find((s) => s.blockIdx === 2)?.seqEnd).toBe(5);
});

// ── generation: an unparseable summarizer output skips the block (retried later) ──

test("a summarizer emitting unparseable output writes no digest for that block; a later good run fills it", async () => {
  const { db, chatId } = await makeChat(SCRIPT);
  // "{ truncated" → parseDigest sees a leading "{" with no valid JSON → empty text → block skipped.
  const garbageSummarizer: Summarizer = {
    summarize: () => Promise.resolve({ text: "{ truncated", model: "fake" }),
  };

  const r1 = await generateDigests(
    db,
    { embedder: fakeEmbedder, summarizer: garbageSummarizer },
    { chatId, params: mem() },
  );
  expect(r1.written).toBe(0); // every block parsed empty → nothing stored
  expect(await digestsOf(db, chatId)).toHaveLength(0);

  // The blocks are still missing, so a subsequent healthy run regenerates them.
  const r2 = await generateDigests(db, genDeps, { chatId, params: mem() });
  expect(r2.written).toBe(3);
  expect(await digestsOf(db, chatId)).toHaveLength(3);
});
