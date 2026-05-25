import { expect, test } from "vitest";
import { createCorpusService } from "../../src/server/domain/corpus";
import { createSearchService } from "../../src/server/domain/search";
import type { Embedder } from "../../src/server/embeddings/embedder";
import type { RerankDoc, Reranker } from "../../src/server/embeddings/reranker";
import { freshDb } from "../support/db";

// Crafted vectors so the query is nearest to "alpha", then "beta", then "gamma" (the vector
// stage's order). The fake reranker then prefers the REVERSE — proving stage 2 reorders.
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
  query: vec({ 0: 1, 1: 0.2, 2: 0.1 }),
  alpha: vec({ 0: 1 }),
  beta: vec({ 0: 1, 1: 0.5 }),
  gamma: vec({ 0: 1, 2: 1 }),
};
const embedder: Embedder = {
  model: "fake",
  embed: (t) => Promise.resolve(VEC[t] ?? new Float32Array(1024)),
  embedBatch: (texts) => Promise.resolve(texts.map((t) => VEC[t] ?? new Float32Array(1024))),
};

// Records what it was asked to score (to assert source_text reached it) and prefers
// gamma > beta > alpha — the opposite of the vector order.
function makeReranker(): { reranker: Reranker; calls: { query: string; docs: RerankDoc[] }[] } {
  const calls: { query: string; docs: RerankDoc[] }[] = [];
  const pref: Record<string, number> = { alpha: 1, beta: 2, gamma: 3 };
  const reranker: Reranker = {
    model: "fake-rerank",
    rerank: (query, docs) => {
      calls.push({ query, docs });
      return Promise.resolve(
        docs.map((d) => ({ id: d.id, score: pref[d.text] ?? 0 })).sort((a, b) => b.score - a.score),
      );
    },
  };
  return { reranker, calls };
}

test("knn stores source_text and stage-1 orders by vector distance", async () => {
  const db = await freshDb();
  const corpus = createCorpusService(db, { embedder });
  await corpus.embedAndStore({ entityType: "character", entityId: "a", text: "alpha" });
  await corpus.embedAndStore({ entityType: "character", entityId: "b", text: "beta" });
  await corpus.embedAndStore({ entityType: "character", entityId: "c", text: "gamma" });

  const { reranker } = makeReranker();
  const hits = await createSearchService(db, { embedder, reranker }).knn({
    queryText: "query",
    k: 3,
  });

  expect(hits.map((h) => h.entityId)).toEqual(["a", "b", "c"]); // nearest-first by cosine
});

test("two-stage rerank reorders the pool by cross-encoder score over the stored source_text", async () => {
  const db = await freshDb();
  const corpus = createCorpusService(db, { embedder });
  await corpus.embedAndStore({ entityType: "character", entityId: "a", text: "alpha" });
  await corpus.embedAndStore({ entityType: "character", entityId: "b", text: "beta" });
  await corpus.embedAndStore({ entityType: "character", entityId: "c", text: "gamma" });

  const { reranker, calls } = makeReranker();
  const reranked = await createSearchService(db, { embedder, reranker }).knn({
    queryText: "query",
    k: 3,
    rerank: true,
  });

  // reranker put gamma first; the vector stage had it last
  expect(reranked.map((h) => h.entityId)).toEqual(["c", "b", "a"]);
  // it scored the STORED source_text (not ids), so the pipeline fetched + passed it through
  expect(calls[0]?.docs.map((d) => d.text).sort()).toEqual(["alpha", "beta", "gamma"]);
});
