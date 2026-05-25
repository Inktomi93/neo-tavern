import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { Db } from "../../src/db/client";
import { embeddings } from "../../src/db/schema";
import { computeHubScores } from "../../src/server/domain/corpus";
import { createSearchService } from "../../src/server/domain/search";
import type { Embedder } from "../../src/server/embeddings/embedder";
import { freshDb } from "../support/db";

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

// Query embedder always returns Q (knn embeds the query text only; computeHubScores reads
// stored vectors and never touches the embedder).
const queryEmbedder: Embedder = {
  model: "fake",
  embed: () => Promise.resolve(Q),
  embedBatch: (texts) => Promise.resolve(texts.map(() => Q)),
};

interface Seed {
  entityType: string;
  entityId: string;
  vec: Float32Array;
}
async function seed(db: Db, rows: Seed[]): Promise<void> {
  const now = Date.now();
  await db.insert(embeddings).values(
    rows.map((r) => ({
      id: r.entityId,
      entityType: r.entityType,
      entityId: r.entityId,
      model: "fake",
      embedding: r.vec,
      createdAt: now,
    })),
  );
}
const CLUSTER: Seed[] = [
  { entityType: "character", entityId: "c1", vec: C1 },
  { entityType: "character", entityId: "c2", vec: C2 },
  { entityType: "character", entityId: "c3", vec: C3 },
  { entityType: "character", entityId: "specific", vec: S },
];

async function hubOf(db: Db, id: string): Promise<number | null> {
  const row = (
    await db.select({ h: embeddings.hubScore }).from(embeddings).where(eq(embeddings.id, id))
  )[0];
  return row?.h ?? null;
}

test("computeHubScores: dense-cluster rows score high, the isolated row low; sparse type zeroed", async () => {
  const db = await freshDb();
  await seed(db, [
    ...CLUSTER,
    // a second entity_type with < K+1 members → zeroed (mirrors card-curator len<K+1 → 0)
    { entityType: "chat_segment", entityId: "seg0", vec: vec({ 5: 1 }) },
    { entityType: "chat_segment", entityId: "seg1", vec: vec({ 6: 1 }) },
  ]);

  const stats = await computeHubScores(db, { k: 2 });

  const hubC2 = (await hubOf(db, "c2")) ?? 0;
  const hubSpecific = (await hubOf(db, "specific")) ?? 0;
  expect(hubC2).toBeGreaterThan(0.9); // c2's 2 nearest are c1/c3 (~0.99 sim)
  expect(hubSpecific).toBeLessThan(0.2); // S's nearest are the distant cluster
  expect(hubC2).toBeGreaterThan(hubSpecific);

  // sparse type: both zeroed, none computed. (Variable keys: byType is an index-signature
  // Record, so dot access trips tsc's noPropertyAccessFromIndexSignature; a literal bracket
  // key would trip biome's useLiteralKeys — a non-literal key satisfies both.)
  const Char = "character";
  const Seg = "chat_segment";
  expect(await hubOf(db, "seg0")).toBe(0);
  expect(await hubOf(db, "seg1")).toBe(0);
  expect(stats.byType[Char]?.computed).toBe(4);
  expect(stats.byType[Seg]?.skipped).toBe(2);
  expect(stats.byType[Seg]?.computed).toBe(0);
});

test("knn without hub scores ranks by raw distance — the closer hub (c2) first", async () => {
  const db = await freshDb();
  await seed(db, CLUSTER); // hub_score left null (no computeHubScores call)

  const hits = await createSearchService(db, { embedder: queryEmbedder }).knn({
    queryText: "q",
    k: 4,
  });

  expect(hits[0]?.entityId).toBe("c2"); // raw-nearest to Q
});

test("knn after computeHubScores demotes the hub — the specific match (S) ranks first", async () => {
  const db = await freshDb();
  await seed(db, CLUSTER);

  await computeHubScores(db, { k: 2 });
  const hits = await createSearchService(db, { embedder: queryEmbedder }).knn({
    queryText: "q",
    k: 4,
  });

  // CSLS flip: raw-nearest was the hub c2; after hubness correction the isolated, specific
  // S wins even though it is farther in raw cosine distance.
  expect(hits[0]?.entityId).toBe("specific");
  expect(hits.map((h) => h.entityId)).toContain("c2");
});
