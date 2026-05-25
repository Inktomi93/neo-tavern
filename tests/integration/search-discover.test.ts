import { expect, test } from "vitest";
import type { Db } from "../../src/db/client";
import { characters, characterVersions, chats, users } from "../../src/db/schema";
import { createCorpusService } from "../../src/server/domain/corpus";
import { createSearchService } from "../../src/server/domain/search";
import type { Embedder } from "../../src/server/embeddings/embedder";
import { freshDb } from "../support/db";

// Crafted vectors: the query "dragon" is near both of Aragorn's segments and far from Bob's.
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
  dragon: vec({ 0: 1 }),
  "dragon battle at the keep": vec({ 0: 0.95, 1: 0.1 }),
  "the dragon hoard of gold": vec({ 0: 0.9, 1: 0.2 }),
  "grocery shopping on a tuesday": vec({ 2: 1 }),
};
const embedder: Embedder = {
  model: "fake",
  embed: (t) => Promise.resolve(VEC[t] ?? new Float32Array(1024)),
  embedBatch: (texts) => Promise.resolve(texts.map((t) => VEC[t] ?? new Float32Array(1024))),
};

async function seedWorld(db: Db): Promise<void> {
  const now = Date.now();
  await db.insert(users).values([
    { id: "uA", handle: "owner-a", createdAt: now },
    { id: "uB", handle: "owner-b", createdAt: now },
  ]);
  // characters must exist before their versions (FK character_versions.characterId, 0007).
  await db.insert(characters).values([
    { id: "A", ownerId: "uA", handle: "aragorn", createdAt: now },
    { id: "B", ownerId: "uB", handle: "bob", createdAt: now },
  ]);
  await db.insert(characterVersions).values([
    {
      id: "cvA",
      characterId: "A",
      version: 1,
      name: "Aragorn",
      description: "a ranger king",
      tags: ["fantasy", "hero"],
      createdAt: now,
    },
    {
      id: "cvB",
      characterId: "B",
      version: 1,
      name: "Bob",
      description: "an ordinary guy",
      tags: [],
      createdAt: now,
    },
  ]);
  await db.insert(chats).values([
    {
      id: "chatA1",
      ownerId: "uA",
      title: "A1",
      characterVersionId: "cvA",
      provider: "anthropic-sdk",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "chatB1",
      ownerId: "uB",
      title: "B1",
      characterVersionId: "cvB",
      provider: "anthropic-sdk",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const corpus = createCorpusService(db, { embedder });
  await corpus.embedAndStore({
    entityType: "chat_segment",
    entityId: "chatA1:0",
    text: "dragon battle at the keep",
  });
  await corpus.embedAndStore({
    entityType: "chat_segment",
    entityId: "chatA1:1",
    text: "the dragon hoard of gold",
  });
  await corpus.embedAndStore({
    entityType: "chat_segment",
    entityId: "chatB1:0",
    text: "grocery shopping on a tuesday",
  });
}

test("discover groups matching segments by character, ranked by best, with card + snippets", async () => {
  const db = await freshDb();
  await seedWorld(db);

  const out = await createSearchService(db, { embedder }).discover({ queryText: "dragon", k: 10 });

  // Aragorn first (his two dragon segments are nearest); Bob's grocery segment ranks after.
  expect(out[0]?.characterId).toBe("A");
  expect(out[0]?.name).toBe("Aragorn");
  expect(out[0]?.tags).toEqual(["fantasy", "hero"]);
  expect(out[0]?.matchCount).toBe(2); // both dragon segments grouped under Aragorn
  expect(out[0]?.segments).toHaveLength(2);
  expect(out[0]?.segments[0]?.snippet).toContain("dragon"); // snippet = the stored segment text
  expect(out.map((c) => c.characterId)).toEqual(["A", "B"]); // characters, not raw segments
});

test("discover is owner-scoped — only the requesting user's conversations", async () => {
  const db = await freshDb();
  await seedWorld(db);

  const scoped = await createSearchService(db, { embedder }).discover({
    queryText: "dragon",
    k: 10,
    ownerId: "uA",
  });

  expect(scoped.map((c) => c.characterId)).toEqual(["A"]); // Bob's chat belongs to uB → excluded
});
