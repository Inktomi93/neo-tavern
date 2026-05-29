import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { Db } from "../../src/db/client";
import { chatDigests, chats, messages } from "../../src/db/schema";
import { newId } from "../../src/server/domain/_shared/ids";
import { createChatService } from "../../src/server/domain/chat";
import { generateDigests } from "../../src/server/domain/chat/memory/generate";
import { createSearchService } from "../../src/server/domain/search/service";
import type { Embedder } from "../../src/server/embeddings/embedder";
import type { Reranker } from "../../src/server/embeddings/reranker";
import type { Summarizer } from "../../src/server/embeddings/summarizer";
import { freshDb } from "../support/db";

// Bag-of-words fake embedder (shared shape with chat-memory.test): word → dim, summed + normalized,
// so texts sharing words land near each other under cosine. Exercises the chat_digests ANN + the
// digest search path deterministically, no GPU.
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
const fakeSummarizer: Summarizer = {
  summarize: (_s, user) => {
    const flat = user.replace(/\s+/g, " ").trim();
    const kw = [...new Set(flat.toLowerCase().match(/[a-z]{4,}/g) ?? [])].slice(0, 12);
    return Promise.resolve({
      text: `[scene]\n- ${flat}\nKEYWORDS: ${kw.join(", ")}`,
      model: "fake",
    });
  },
};
const fakeReranker: Reranker = {
  model: "fake",
  rerank: (_q, docs) => Promise.resolve(docs.map((d) => ({ id: d.id, score: 1 }))),
};

const memParams = { enabled: true, blockSize: 2, verbatimWindow: 2, mode: "mixA" as const };

async function seedChatWithDigests(
  db: Db,
  username: string,
  characterName: string,
  script: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const chat = createChatService(db, { embedder: fakeEmbedder });
  const { chatId } = await chat.create({
    username,
    title: "t",
    characterName,
    characterDescription: "d",
  });
  const now = Date.now();
  for (const [i, m] of script.entries()) {
    await db
      .insert(messages)
      .values({ id: newId(), chatId, seq: i, role: m.role, content: m.content, createdAt: now });
  }
  await generateDigests(
    db,
    { embedder: fakeEmbedder, summarizer: fakeSummarizer },
    { chatId, params: memParams },
  );
  return chatId;
}

const DRAGON: { role: "user" | "assistant"; content: string }[] = [
  { role: "user", content: "good morning friend" },
  { role: "assistant", content: "I am Vermithrax an ancient dragon guarding the northern pass" },
  { role: "user", content: "tell me about your emeralds" },
  { role: "assistant", content: "I hoard emeralds deep in my cavern" },
  { role: "user", content: "and the village nearby" },
  { role: "assistant", content: "the village pays tribute every winter" },
  { role: "user", content: "what now" },
  { role: "assistant", content: "we rest" },
];
const SCIFI: { role: "user" | "assistant"; content: string }[] = [
  { role: "user", content: "captain the spaceship is approaching" },
  { role: "assistant", content: "fire the plasma laser at the asteroid" },
  { role: "user", content: "the hyperdrive is offline" },
  { role: "assistant", content: "reroute power from the shields to the engine" },
  { role: "user", content: "status" },
  { role: "assistant", content: "stable for now" },
  { role: "user", content: "good" },
  { role: "assistant", content: "aye captain" },
];

test("digest search retrieves the relevant digest with its canon seq span", async () => {
  const db = await freshDb();
  await seedChatWithDigests(db, "owner", "Vermithrax", DRAGON);
  const search = createSearchService(db, { embedder: fakeEmbedder, reranker: fakeReranker });

  const hits = await search.digests({
    queryText: "emeralds cavern hoard",
    username: "owner",
    k: 3,
  });
  expect(hits.length).toBeGreaterThan(0);
  const top = hits[0];
  expect(top?.snippet).toContain("emeralds"); // the [2-3] block ranks first for this query
  expect(typeof top?.seqStart).toBe("number"); // seq span present → verbatim click-through
  expect(top?.seqEnd).toBeGreaterThanOrEqual(top?.seqStart ?? 0);
});

test("digest search is scoped to the owner — never returns another user's digests", async () => {
  const db = await freshDb();
  const ownerChat = await seedChatWithDigests(db, "owner", "Vermithrax", DRAGON);
  const otherChat = await seedChatWithDigests(db, "intruder", "Nova", SCIFI);
  const search = createSearchService(db, { embedder: fakeEmbedder, reranker: fakeReranker });

  // Query the OTHER user's content as `owner`: the spaceship digest ranks #1 globally but must be
  // filtered by ownerId — every returned hit belongs to the owner's chat, never the intruder's.
  const hits = await search.digests({
    queryText: "spaceship plasma laser",
    username: "owner",
    k: 5,
  });
  expect(hits.every((h) => h.chatId === ownerChat)).toBe(true);
  expect(hits.some((h) => h.chatId === otherChat)).toBe(false);
});

// ── corpus digest search: tier coverage, CSLS hubness reorder, rerank, empty ──
// These insert digest rows directly (precise control over tier, embedding, hub_score) — the ANN
// index auto-maintains on insert, so vector_top_k finds them.

async function chatIds(
  db: Db,
  username: string,
): Promise<{ chatId: string; ownerId: string; cvId: string }> {
  const chat = createChatService(db, { embedder: fakeEmbedder });
  const { chatId } = await chat.create({
    username,
    title: "t",
    characterName: "V",
    characterDescription: "d",
  });
  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  if (!row) throw new Error("chat row missing");
  return { chatId, ownerId: row.ownerId, cvId: row.characterVersionId };
}

async function insertDigestRow(
  db: Db,
  ids: { chatId: string; ownerId: string; cvId: string },
  d: {
    tier?: number;
    blockIdx: number;
    seqStart: number;
    seqEnd: number;
    text: string;
    hubScore?: number | null;
  },
): Promise<void> {
  await db.insert(chatDigests).values({
    id: newId(),
    chatId: ids.chatId,
    ownerId: ids.ownerId,
    characterVersionId: ids.cvId,
    tier: d.tier ?? 0,
    blockIdx: d.blockIdx,
    seqStart: d.seqStart,
    seqEnd: d.seqEnd,
    text: d.text,
    keywords: [],
    model: "fake",
    embedding: bow(d.text),
    hubScore: d.hubScore ?? null,
    createdAt: Date.now(),
  });
}

test("corpus digest search returns tier-1 arc digests, not only tier-0", async () => {
  const db = await freshDb();
  const chat = createChatService(db, { embedder: fakeEmbedder });
  const { chatId } = await chat.create({
    username: "owner",
    title: "t",
    characterName: "Vermithrax",
    characterDescription: "d",
  });
  const now = Date.now();
  for (const [i, m] of DRAGON.entries())
    await db
      .insert(messages)
      .values({ id: newId(), chatId, seq: i, role: m.role, content: m.content, createdAt: now });
  // fanOut 2 → 3 tier-0 blocks consolidate into a tier-1 arc.
  await generateDigests(
    db,
    { embedder: fakeEmbedder, summarizer: fakeSummarizer },
    { chatId, params: { ...memParams, fanOut: 2, maxTier: 1 } },
  );

  const search = createSearchService(db, { embedder: fakeEmbedder, reranker: fakeReranker });
  const hits = await search.digests({
    queryText: "emeralds village dragon",
    username: "owner",
    k: 10,
  });

  expect(hits.some((h) => h.tier === 1)).toBe(true); // the arc-level digest is searchable, not filtered out
});

test("CSLS hub_score reorders results: a low-hub digest outranks a high-hub one at equal distance", async () => {
  const db = await freshDb();
  const ids = await chatIds(db, "owner");
  await insertDigestRow(db, ids, {
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "shared term raretoken",
    hubScore: 0.1,
  });
  await insertDigestRow(db, ids, {
    blockIdx: 1,
    seqStart: 2,
    seqEnd: 3,
    text: "shared term hubtoken",
    hubScore: 0.9,
  });

  const search = createSearchService(db, { embedder: fakeEmbedder, reranker: fakeReranker });
  const hits = await search.digests({ queryText: "shared term", username: "owner", k: 2 });

  expect(hits[0]?.snippet).toContain("raretoken"); // lower hub_score → better adjusted rank
});

test("corpus digest search rerank=true lets the cross-encoder override distance order", async () => {
  const db = await freshDb();
  const ids = await chatIds(db, "owner");
  await insertDigestRow(db, ids, {
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "common common closer",
  }); // nearest by cosine
  await insertDigestRow(db, ids, { blockIdx: 1, seqStart: 2, seqEnd: 3, text: "common WINNER" }); // farther, but promoted

  const winnerReranker: Reranker = {
    model: "fake",
    rerank: (_q, docs) =>
      Promise.resolve(
        [...docs]
          .sort((a, b) => (b.text.includes("WINNER") ? 1 : 0) - (a.text.includes("WINNER") ? 1 : 0))
          .map((d) => ({ id: d.id, score: 1 })),
      ),
  };
  const search = createSearchService(db, { embedder: fakeEmbedder, reranker: winnerReranker });
  const hits = await search.digests({ queryText: "common", username: "owner", k: 5, rerank: true });

  expect(hits[0]?.snippet).toContain("WINNER"); // rerank promoted it above the closer-by-cosine digest
});

test("corpus digest search over an empty corpus returns no hits", async () => {
  const db = await freshDb();
  await chatIds(db, "owner"); // user exists, but no digests
  const search = createSearchService(db, { embedder: fakeEmbedder, reranker: fakeReranker });

  const hits = await search.digests({ queryText: "anything", username: "owner", k: 5 });
  expect(hits).toEqual([]);
});
