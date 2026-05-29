import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { Db } from "../../src/db/client";
import { chatDigests, messages } from "../../src/db/schema";
import { newId } from "../../src/server/domain/_shared/ids";
import { createChatService } from "../../src/server/domain/chat";
import { generateDigests } from "../../src/server/domain/chat/memory/generate";
import { retrieveMemory } from "../../src/server/domain/chat/memory/retrieve";
import type { Embedder } from "../../src/server/embeddings/embedder";
import type { Reranker } from "../../src/server/embeddings/reranker";
import type { Summarizer } from "../../src/server/embeddings/summarizer";
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
