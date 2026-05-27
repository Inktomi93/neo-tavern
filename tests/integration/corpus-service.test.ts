import { expect, test } from "vitest";
import { createCorpusService } from "../../src/server/domain/corpus";
import { createSearchService } from "../../src/server/domain/search";
import type { Embedder } from "../../src/server/embeddings/embedder";
import { freshDb, seedCharacter } from "../support/db";

// Deterministic fake embedder: each distinct text → a distinct one-hot basis vector, so
// an identical query text round-trips to cosine-distance 0. Exercises embedAndStore +
// knn against the real libsql_vector_idx ANN index (freshDb runs the migrations).
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
  const c1 = await seedCharacter(db, { id: "c1", ownerId: "u1" });
  await corpus.embedAndStore({
    characterId: "c1",
    ownerId: "u1",
    characterVersionId: c1.characterVersionId,
    text: "alpha dragon",
  });

  const keys = await corpus.existingKeys();
  expect(keys.has("c1")).toBe(true); // existingKeys tracks characterIds for the resumable pass
  expect(keys.size).toBe(1);

  const search = createSearchService(db, { embedder: fakeEmbedder });
  const hits = await search.knn({ queryText: "alpha dragon", k: 2 });
  expect(hits[0]?.entityId).toBe("c1"); // exact-text match ranks first through the ANN index
});

test("embedAndStoreMany batch-inserts retrievable vectors in one pass", async () => {
  const db = await freshDb();
  const corpus = createCorpusService(db, { embedder: fakeEmbedder });
  const b1 = await seedCharacter(db, { id: "b1", ownerId: "u1" });
  const b2 = await seedCharacter(db, { id: "b2", ownerId: "u1" });
  const n = await corpus.embedAndStoreMany([
    { characterId: "b1", ownerId: "u1", characterVersionId: b1.characterVersionId, text: "gamma" },
    { characterId: "b2", ownerId: "u1", characterVersionId: b2.characterVersionId, text: "delta" },
  ]);
  expect(n).toBe(2);
  expect((await corpus.existingKeys()).size).toBe(2);

  const search = createSearchService(db, { embedder: fakeEmbedder });
  const hits = await search.knn({ queryText: "delta", k: 3 });
  expect(hits[0]?.entityId).toBe("b2");
});

test("owner-scoped knn returns only the requesting owner's characters", async () => {
  const db = await freshDb();
  const cA = await seedCharacter(db, { id: "cA", ownerId: "uA" });
  const cB = await seedCharacter(db, { id: "cB", ownerId: "uB" });
  const corpus = createCorpusService(db, { embedder: fakeEmbedder });
  // same text → same vector → both are equally near the query
  await corpus.embedAndStore({
    characterId: "cA",
    ownerId: "uA",
    characterVersionId: cA.characterVersionId,
    text: "alpha",
  });
  await corpus.embedAndStore({
    characterId: "cB",
    ownerId: "uB",
    characterVersionId: cB.characterVersionId,
    text: "alpha",
  });

  const search = createSearchService(db, { embedder: fakeEmbedder });
  expect((await search.knn({ queryText: "alpha", k: 10 })).length).toBe(2); // unscoped: both
  const scoped = await search.knn({ queryText: "alpha", k: 10, ownerId: "uA" });
  expect(scoped.map((h) => h.entityId)).toEqual(["cA"]); // scoped: only owner A's
});

test("a duplicate (character, model) insert errors loudly (no silent second vector)", async () => {
  const db = await freshDb();
  const corpus = createCorpusService(db, { embedder: fakeEmbedder });
  const dup = await seedCharacter(db, { id: "dup", ownerId: "u1" });
  await corpus.embedAndStore({
    characterId: "dup",
    ownerId: "u1",
    characterVersionId: dup.characterVersionId,
    text: "x",
  });
  await expect(
    corpus.embedAndStore({
      characterId: "dup",
      ownerId: "u1",
      characterVersionId: dup.characterVersionId,
      text: "y",
    }),
  ).rejects.toThrow();
});
