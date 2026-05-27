import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { Db } from "../../src/db/client";
import { characterEmbeddings } from "../../src/db/schema";
import { computeCharacterHubScores } from "../../src/server/domain/corpus";
import { createSearchService } from "../../src/server/domain/search";
import type { Embedder } from "../../src/server/embeddings/embedder";
import { freshDb, seedCharacter } from "../support/db";

// Crafted unit vectors in a 3-active-dim subspace (rest zero), normalized — so cosine
// distance is exact and controllable. Geometry:
//   cluster c1/c2/c3 ≈ e0 (mutually ~0.99 similar)  → high hub_score (a dense hub region)
//   specific S = e1                                  → far from the cluster → low hub_score
//   query Q = (0.8, 0.6) leans toward the cluster    → raw-nearest is the hub c2,
//                                                       but the specific S should win post-CSLS
function vec(entries: Record<number, number>): Float32Array {
  const v = new Float32Array(1024);
  for (const [i, x] of Object.entries(entries)) v[Number(i)] = x;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i += 1) v[i] = (v[i] ?? 0) / norm;
  return v;
}

const C1 = vec({ 0: 1 });
const C2 = vec({ 0: 1, 1: 0.1 });
const C3 = vec({ 0: 1, 2: 0.1 });
const S = vec({ 1: 1 });
const Q = vec({ 0: 0.8, 1: 0.6 });

// Query embedder always returns Q (knn embeds the query text only; computeCharacterHubScores reads
// stored vectors and never touches the embedder).
const queryEmbedder: Embedder = {
  model: "fake",
  embed: () => Promise.resolve(Q),
  embedBatch: (texts) => Promise.resolve(texts.map(() => Q)),
};

// Seed the cluster as four character cards (real FK chain), each with a crafted vector. The
// character_embeddings row id == characterId so hubOf/knn assertions key on the same id.
async function seedCluster(db: Db): Promise<void> {
  const now = Date.now();
  for (const r of [
    { id: "c1", vec: C1 },
    { id: "c2", vec: C2 },
    { id: "c3", vec: C3 },
    { id: "specific", vec: S },
  ]) {
    const { characterVersionId } = await seedCharacter(db, { id: r.id, ownerId: "u1" });
    await db.insert(characterEmbeddings).values({
      id: r.id,
      characterId: r.id,
      ownerId: "u1",
      characterVersionId,
      model: "fake",
      embedding: r.vec,
      createdAt: now,
    });
  }
}

async function hubOf(db: Db, id: string): Promise<number | null> {
  const row = (
    await db
      .select({ h: characterEmbeddings.hubScore })
      .from(characterEmbeddings)
      .where(eq(characterEmbeddings.characterId, id))
  )[0];
  return row?.h ?? null;
}

test("computeCharacterHubScores: dense-cluster rows score high, the isolated row low", async () => {
  const db = await freshDb();
  await seedCluster(db);

  const stats = await computeCharacterHubScores(db, { k: 2 });

  const hubC2 = (await hubOf(db, "c2")) ?? 0;
  const hubSpecific = (await hubOf(db, "specific")) ?? 0;
  expect(hubC2).toBeGreaterThan(0.9); // c2's 2 nearest are c1/c3 (~0.99 sim)
  expect(hubSpecific).toBeLessThan(0.2); // S's nearest are the distant cluster
  expect(hubC2).toBeGreaterThan(hubSpecific);

  // byType is an index-signature Record; a non-literal key satisfies both tsc's
  // noPropertyAccessFromIndexSignature and biome's useLiteralKeys.
  const Char = "character";
  expect(stats.byType[Char]?.computed).toBe(4);
});

test("knn without hub scores ranks by raw distance — the closer hub (c2) first", async () => {
  const db = await freshDb();
  await seedCluster(db); // hub_score left null (no computeCharacterHubScores call)

  const hits = await createSearchService(db, { embedder: queryEmbedder }).knn({
    queryText: "q",
    k: 4,
  });

  expect(hits[0]?.entityId).toBe("c2"); // raw-nearest to Q
});

test("knn after computeCharacterHubScores demotes the hub — the specific match (S) ranks first", async () => {
  const db = await freshDb();
  await seedCluster(db);

  await computeCharacterHubScores(db, { k: 2 });
  const hits = await createSearchService(db, { embedder: queryEmbedder }).knn({
    queryText: "q",
    k: 4,
  });

  // CSLS flip: raw-nearest was the hub c2; after hubness correction the isolated, specific
  // S wins even though it is farther in raw cosine distance.
  expect(hits[0]?.entityId).toBe("specific");
  expect(hits.map((h) => h.entityId)).toContain("c2");
});
