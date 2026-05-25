import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import { CSLS_K, computeHubScores } from "../src/server/domain/corpus";
import { env } from "../src/server/env";

/**
 * CSLS hubness precompute (Phase 4.6.3a): fill `embeddings.hub_score` (mean cosine-sim to
 * the K=10 nearest same-(type,model) neighbours) per entity_type, so search can demote
 * "matches-everything" hubs at query time. Index-time batch pass — run AFTER `pnpm
 * embed:corpus`, re-run when the corpus changes. Reads stored vectors via the ANN index;
 * no model load / GPU needed. See docs/corpus-import.md (RAG section).
 */
async function main(): Promise<void> {
  console.log(`[csls] DB ${env.DATABASE_URL} · K=${CSLS_K}`);
  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);

  const t0 = Date.now();
  const stats = await computeHubScores(db);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  for (const [type, s] of Object.entries(stats.byType)) {
    console.log(
      `[csls]   ${type}: ${s.computed} computed · ${s.skipped} zeroed (< K+1) · ${s.count} total`,
    );
  }
  console.log(`[csls] ✅ ${stats.total} rows in ${secs}s (exact same-type top-K)`);
}

await main().catch((error: unknown) => {
  console.error("[csls] failed:", error);
  process.exitCode = 1;
});
