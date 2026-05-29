import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { Db } from "../../src/db/client";
import { chatSegments, messages } from "../../src/db/schema";
import { newId } from "../../src/server/domain/_shared/ids";

import { generateDigests, generateSegments } from "../../src/server/domain/chat/memory/generate";
import { createSearchService } from "../../src/server/domain/search/service";
import type { Embedder } from "../../src/server/embeddings/embedder";
import type { Reranker } from "../../src/server/embeddings/reranker";
import type { Summarizer } from "../../src/server/embeddings/summarizer";
import { freshDb, seedChatRow } from "../support/db";

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
const fakeReranker: Reranker = {
  model: "fake",
  rerank: (_q, docs) => Promise.resolve(docs.map((d) => ({ id: d.id, score: 1 }))),
};
const fakeSummarizer: Summarizer = {
  summarize: (_s, user) =>
    Promise.resolve({ text: `[scene]\n- ${user.replace(/\s+/g, " ").trim()}`, model: "fake" }),
};

const DRAGON: { role: "user" | "assistant"; content: string }[] = [
  { role: "user", content: "good morning friend" },
  { role: "assistant", content: "I am Vermithrax an ancient dragon guarding the northern pass" },
  { role: "user", content: "tell me about your emeralds" },
  { role: "assistant", content: "I hoard emeralds deep in my cavern" },
  { role: "user", content: "and the village nearby" },
  { role: "assistant", content: "the village pays tribute every winter" },
  { role: "user", content: "what now" },
  { role: "assistant", content: "we rest by the fire" },
];
const SCIFI: { role: "user" | "assistant"; content: string }[] = [
  { role: "user", content: "captain the spaceship is approaching" },
  { role: "assistant", content: "fire the plasma laser at the asteroid" },
  { role: "user", content: "the hyperdrive is offline" },
  { role: "assistant", content: "reroute power from the shields to the engine" },
  { role: "user", content: "status report" },
  { role: "assistant", content: "stable for now captain" },
];

async function seedChat(
  db: Db,
  username: string,
  characterName: string,
  script: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const { chatId } = await seedChatRow(db, { ownerId: username, name: characterName, title: "t" });
  const now = Date.now();
  for (const [i, m] of script.entries()) {
    await db
      .insert(messages)
      .values({ id: newId(), chatId, seq: i, role: m.role, content: m.content, createdAt: now });
  }
  return chatId;
}

test("generateSegments indexes ALL completed blocks (whole chat, not just aged-out)", async () => {
  const db = await freshDb();
  const chatId = await seedChat(db, "owner", "Vermithrax", DRAGON);
  // No memory config / no digests — segments run independent of the memory toggle.
  const { written } = await generateSegments(
    db,
    { embedder: fakeEmbedder },
    { chatId, blockSize: 2 },
  );
  expect(written).toBe(4); // 8 msgs / 2 = 4 complete blocks
  const rows = await db.select().from(chatSegments).where(eq(chatSegments.chatId, chatId));
  expect(rows).toHaveLength(4);
  // Unlike digests (which stop at the verbatim window), segments cover the LATEST messages too.
  expect(Math.max(...rows.map((r) => r.seqEnd))).toBe(7);
});

test("search.segments retrieves the relevant raw block, owner-scoped", async () => {
  const db = await freshDb();
  const ownerChat = await seedChat(db, "owner", "Vermithrax", DRAGON);
  await generateSegments(db, { embedder: fakeEmbedder }, { chatId: ownerChat, blockSize: 2 });
  const intruderChat = await seedChat(db, "intruder", "Nova", SCIFI);
  await generateSegments(db, { embedder: fakeEmbedder }, { chatId: intruderChat, blockSize: 2 });
  const search = createSearchService(db, { embedder: fakeEmbedder, reranker: fakeReranker });

  const hits = await search.segments({
    queryText: "emeralds cavern hoard",
    username: "owner",
    k: 3,
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.snippet).toContain("emeralds");

  // Owner scoping: the intruder's spaceship block ranks #1 globally but is filtered out.
  const sci = await search.segments({
    queryText: "spaceship plasma laser",
    username: "owner",
    k: 5,
  });
  expect(sci.every((h) => h.chatId === ownerChat)).toBe(true);
});

test("corpus search returns both lenses (digests + segments)", async () => {
  const db = await freshDb();
  const chatId = await seedChat(db, "owner", "Vermithrax", DRAGON);
  await generateDigests(
    db,
    { embedder: fakeEmbedder, summarizer: fakeSummarizer },
    { chatId, params: { enabled: true, blockSize: 2, verbatimWindow: 2, mode: "mixA" } },
  );
  await generateSegments(db, { embedder: fakeEmbedder }, { chatId, blockSize: 2 });
  const search = createSearchService(db, { embedder: fakeEmbedder, reranker: fakeReranker });

  const res = await search.corpus({ queryText: "emeralds", username: "owner", k: 10 });
  expect(res.length).toBeGreaterThan(0);
  // Unified list, deduped per block — both lenses surface (digest blocks + the uncovered recent
  // segment block that has no digest), each tagged by source.
  expect(res.some((h) => h.source === "digest")).toBe(true);
  expect(res.some((h) => h.source === "segment")).toBe(true);
});
