import { eq, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { embeddings } from "../../src/db/schema";
import { freshDb } from "../support/db";

// Deterministic vector-pipe proof (NO model): the F32_BLOB customType insert +
// round-trip, the libsql_vector_idx ANN index, and vector_top_k + vector_distance_cos.
// The real BGE-M3 embedding is proven separately by `pnpm embed:probe`.
function vec(nonZero: Record<number, number>): Float32Array {
  const v = new Float32Array(1024);
  for (const [i, x] of Object.entries(nonZero)) {
    v[Number(i)] = x;
  }
  return v;
}

test("F32_BLOB round-trips and vector_top_k ranks the nearer vector first", async () => {
  const db = await freshDb();
  const now = Date.now();
  await db.insert(embeddings).values([
    {
      id: "a",
      entityType: "test",
      entityId: "a",
      model: "synthetic",
      embedding: vec({ 0: 1 }),
      createdAt: now,
    },
    {
      id: "b",
      entityType: "test",
      entityId: "b",
      model: "synthetic",
      embedding: vec({ 1: 1 }),
      createdAt: now,
    },
  ]);

  // Query nearer to "a". ANN-limit via the index, then exact cosine re-rank.
  const query = JSON.stringify(Array.from(vec({ 0: 0.9, 1: 0.1 })));
  const ranked = await db.all<{ id: string; dist: number }>(sql`
    SELECT e.id AS id, vector_distance_cos(e.embedding, vector32(${query})) AS dist
    FROM vector_top_k('embeddings_ann', vector32(${query}), 5) AS v
    JOIN embeddings e ON e.rowid = v.id
    ORDER BY dist ASC
  `);

  expect(ranked.map((r) => r.id)).toEqual(["a", "b"]);

  // fromDriver round-trip.
  const rows = await db
    .select({ embedding: embeddings.embedding })
    .from(embeddings)
    .where(eq(embeddings.id, "a"));
  expect(rows[0]?.embedding?.length).toBe(1024);
  expect(rows[0]?.embedding?.[0]).toBeCloseTo(1, 5);
});
