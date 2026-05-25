import { expect, test } from "vitest";
import { characters, users } from "../../src/db/schema";
import { createCorpusService, embeddingKey } from "../../src/server/domain/corpus";
import { createSearchService } from "../../src/server/domain/search";
import type { Embedder } from "../../src/server/embeddings/embedder";
import { freshDb } from "../support/db";

// Deterministic fake embedder: each distinct text → a distinct one-hot basis vector, so
// an identical query text round-trips to cosine-distance 0. Exercises embedAndStore +
// knn against the real libsql_vector_idx ANN index (freshDb runs the migrations) — which
// is exactly where the ON CONFLICT upsert failed ("insert shadow row").
const dimOf = new Map<string, number>();
function basisVec(text: string): Float32Array {
  let d = dimOf.get(text);
  if (d === undefined) {
    d = dimOf.size;
    dimOf.set(text, d);
  }
  const v = new Float32Array(1024);
  v[d] = 1;
  return v;
}
const fakeEmbedder: Embedder = {
  model: "fake",
  embed: (t) => Promise.resolve(basisVec(t)),
  embedBatch: (texts) => Promise.resolve(texts.map(basisVec)),
};

test("embedAndStore inserts retrievable vectors; existingKeys tracks them; knn round-trips", async () => {
  const db = await freshDb();
  const corpus = createCorpusService(db, { embedder: fakeEmbedder });
  await corpus.embedAndStore({ entityType: "character", entityId: "c1", text: "alpha dragon" });
  await corpus.embedAndStore({
    entityType: "chat_segment",
    entityId: "ch1:0",
    text: "beta castle",
    metadata: { chatId: "ch1" },
  });

  const keys = await corpus.existingKeys();
  expect(keys.has(embeddingKey("character", "c1"))).toBe(true);
  expect(keys.has(embeddingKey("chat_segment", "ch1:0"))).toBe(true);
  expect(keys.size).toBe(2);

  const search = createSearchService(db, { embedder: fakeEmbedder });
  const hits = await search.knn({ queryText: "alpha dragon", k: 2 });
  expect(hits[0]?.entityId).toBe("c1"); // exact-text match ranks first through the ANN index
});

test("embedAndStoreMany batch-inserts retrievable vectors in one pass", async () => {
  const db = await freshDb();
  const corpus = createCorpusService(db, { embedder: fakeEmbedder });
  const n = await corpus.embedAndStoreMany([
    { entityType: "character", entityId: "b1", text: "gamma" },
    { entityType: "character", entityId: "b2", text: "delta" },
    { entityType: "chat_segment", entityId: "b3:0", text: "epsilon" },
  ]);
  expect(n).toBe(3);
  expect((await corpus.existingKeys()).size).toBe(3);

  const search = createSearchService(db, { embedder: fakeEmbedder });
  const hits = await search.knn({ queryText: "delta", k: 3 });
  expect(hits[0]?.entityId).toBe("b2");
});

test("owner-scoped knn returns only the requesting owner's entities", async () => {
  const db = await freshDb();
  const now = Date.now();
  await db.insert(users).values([
    { id: "uA", handle: "owner-a", createdAt: now },
    { id: "uB", handle: "owner-b", createdAt: now },
  ]);
  await db.insert(characters).values([
    { id: "cA", ownerId: "uA", handle: "char-a", createdAt: now },
    { id: "cB", ownerId: "uB", handle: "char-b", createdAt: now },
  ]);
  const corpus = createCorpusService(db, { embedder: fakeEmbedder });
  // same text → same vector → both are equally near the query
  await corpus.embedAndStore({ entityType: "character", entityId: "cA", text: "alpha" });
  await corpus.embedAndStore({ entityType: "character", entityId: "cB", text: "alpha" });

  const search = createSearchService(db, { embedder: fakeEmbedder });
  expect((await search.knn({ queryText: "alpha", k: 10 })).length).toBe(2); // unscoped: both
  const scoped = await search.knn({ queryText: "alpha", k: 10, ownerId: "uA" });
  expect(scoped.map((h) => h.entityId)).toEqual(["cA"]); // scoped: only owner A's
});

test("a duplicate (entity, model) insert errors loudly (no silent second vector)", async () => {
  const db = await freshDb();
  const corpus = createCorpusService(db, { embedder: fakeEmbedder });
  await corpus.embedAndStore({ entityType: "character", entityId: "dup", text: "x" });
  await expect(
    corpus.embedAndStore({ entityType: "character", entityId: "dup", text: "y" }),
  ).rejects.toThrow();
});
