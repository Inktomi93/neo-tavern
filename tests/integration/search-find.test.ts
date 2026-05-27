import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { characters, characterVersions, chatSegments, chats, users } from "../../src/db/schema";
import { newId } from "../../src/server/domain/_shared/ids";
import { createCorpusService } from "../../src/server/domain/corpus";
import { createSearchService } from "../../src/server/domain/search";
import type { Embedder } from "../../src/server/embeddings/embedder";
import { freshDb } from "../support/db";

function vec(entries: Record<number, number>): Float32Array {
  const v = new Float32Array(1024);
  for (const [i, x] of Object.entries(entries)) v[Number(i)] = x;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i += 1) v[i] = (v[i] ?? 0) / norm;
  return v;
}
const VEC: Record<string, Float32Array> = {
  hero: vec({ 0: 1, 1: 0.05, 2: 0.05 }),
  "ranger king of the north": vec({ 0: 1, 1: 0.1 }),
  "the dragon battle at the keep": vec({ 0: 0.95, 2: 0.1 }),
};
const embedder: Embedder = {
  model: "fake",
  embed: (t) => Promise.resolve(VEC[t] ?? new Float32Array(1024)),
  embedBatch: (texts) => Promise.resolve(texts.map((t) => VEC[t] ?? new Float32Array(1024))),
};

test("find enriches knn hits — character hits carry name+tags, segment hits carry snippet+character", async () => {
  const db = await freshDb();
  const now = Date.now();
  await db.insert(users).values({ id: "uA", handle: "owner-a", createdAt: now });
  // Character before version (FK), then repoint currentVersionId (find resolves the card via it).
  await db.insert(characters).values({ id: "A", ownerId: "uA", handle: "aragorn", createdAt: now });
  await db.insert(characterVersions).values({
    id: "cvA",
    characterId: "A",
    version: 1,
    name: "Aragorn",
    description: "a ranger king",
    tags: ["fantasy"],
    createdAt: now,
  });
  await db.update(characters).set({ currentVersionId: "cvA" }).where(eq(characters.id, "A"));
  await db.insert(chats).values({
    id: "chatA1",
    ownerId: "uA",
    title: "A1",
    characterVersionId: "cvA",
    createdAt: now,
    updatedAt: now,
  });

  const corpus = createCorpusService(db, { embedder });
  await corpus.embedAndStore({
    entityType: "character",
    entityId: "A",
    text: "ranger king of the north",
  });
  // Phase B: the segment lives in chat_segments (block-bounded), not the polymorphic embeddings.
  await db.insert(chatSegments).values({
    id: newId(),
    chatId: "chatA1",
    ownerId: "uA",
    characterVersionId: "cvA",
    blockIdx: 0,
    seqStart: 0,
    seqEnd: 1,
    text: "the dragon battle at the keep",
    model: "fake",
    embedding: VEC["the dragon battle at the keep"] ?? new Float32Array(1024),
    createdAt: now,
  });

  const results = await createSearchService(db, { embedder }).find({ queryText: "hero", k: 10 });

  const char = results.find((r) => r.kind === "character");
  const seg = results.find((r) => r.kind === "segment");
  expect(char).toMatchObject({
    kind: "character",
    entityId: "A",
    name: "Aragorn",
    tags: ["fantasy"],
  });
  expect(seg).toMatchObject({
    kind: "segment",
    characterName: "Aragorn",
    chatId: "chatA1",
    segIndex: 0,
  });
  expect(seg?.kind === "segment" && seg.snippet).toContain("dragon");
});
