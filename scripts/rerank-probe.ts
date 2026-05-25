import process from "node:process";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { createEmbedder } from "../src/server/embeddings/embedder";
import { createReranker } from "../src/server/embeddings/reranker";
import { env } from "../src/server/env";

/**
 * Validate the REAL reranker (onnx-community/bge-reranker-v2-m3-ONNX) end-to-end on the
 * corpus — the probe counterpart to the synthetic two-stage test (like `pnpm embed:probe`).
 * Embeds a query, builds the CSLS-adjusted character pool, fetches source_text, reranks, and
 * prints the CSLS vs reranked top-5 side by side. GPU: run via the CUDA env (see README).
 */
async function main(): Promise<void> {
  console.log(
    `[rerank-probe] DB ${env.DATABASE_URL} · embed=${env.EMBED_DEVICE} rerank=${env.RERANK_DEVICE}/${env.RERANK_DTYPE}`,
  );
  const db = await createDb(env.DATABASE_URL);
  const embedder = createEmbedder();
  const reranker = createReranker();
  const queries = [
    "a brooding vampire lord in a gothic castle",
    "cheerful bubbly catgirl who loves to cook",
    "hardened cyberpunk mercenary hacker",
  ];
  for (const q of queries) {
    const vec = await embedder.embed(q);
    const query = JSON.stringify(Array.from(vec));
    const rows = await db.all<{
      id: string;
      name: string;
      dist: number;
      hub: number;
      text: string;
    }>(sql`
      SELECT e.entity_id AS id, json_extract(e.metadata,'$.name') AS name,
             vector_distance_cos(e.embedding, vector32(${query})) AS dist,
             e.hub_score AS hub, e.source_text AS text
      FROM vector_top_k('embeddings_ann', vector32(${query}), 40) AS v
      JOIN embeddings e ON e.rowid = v.id
      WHERE e.entity_type = 'character' ORDER BY dist ASC`);
    const csls = [...rows]
      .map((r) => ({ ...r, adj: Math.max(0, r.dist - 1 + r.hub) }))
      .sort((a, b) => a.adj - b.adj);
    const scores = await reranker.rerank(
      q,
      csls.map((r) => ({ id: r.id, text: r.text ?? "" })),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    console.log(`\n## "${q}"`);
    console.log("  CSLS top-5:                      RERANK top-5:");
    for (let i = 0; i < 5; i += 1) {
      const c = csls[i];
      const s = scores[i];
      const left = c ? `${c.adj.toFixed(3)} ${(c.name ?? c.id).slice(0, 22)}` : "";
      const right = s ? `${s.score.toFixed(2)} ${(byId.get(s.id)?.name ?? s.id).slice(0, 20)}` : "";
      console.log(`  ${left.padEnd(33)}${right}`);
    }
  }
}

await main().catch((error: unknown) => {
  console.error("[rerank-probe] failed:", error);
  process.exitCode = 1;
});
