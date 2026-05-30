import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import { computeDuplicatePairs, DEFAULT_DUP_THRESHOLD } from "../src/server/domain/corpus";
import { env } from "../src/server/env";

/**
 * Near-duplicate precompute (docs/planning/breadth-buildout.md B.5) — fill `duplicate_pairs` for both
 * characters and chats via the exact in-process all-pairs matmul (NOT the ANN — see B.7). Run after
 * `pnpm embed:corpus` + `pnpm memory:backfill`; re-run when the corpus changes. Idempotent (replaces
 * each entity type's rows). The tRPC `analytics.duplicate*` endpoints read what this writes.
 *
 *   pnpm find-duplicates                 # default cosine threshold 0.92
 *   pnpm find-duplicates --threshold 0.9 # looser
 */
async function main(): Promise<void> {
  const tArg = process.argv.indexOf("--threshold");
  const threshold = tArg >= 0 ? Number(process.argv[tArg + 1]) : DEFAULT_DUP_THRESHOLD;
  console.log(`[find-duplicates] DB ${env.DATABASE_URL} · cosine ≥ ${threshold}`);

  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);

  const t0 = Date.now();
  const stats = await computeDuplicatePairs(db, { threshold });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(
    `[find-duplicates] characters: ${stats.characters} pairs · chats: ${stats.chats} pairs ` +
      `(${stats.forkedChatPairs} forked lineage, ${stats.chats - stats.forkedChatPairs} independent)`,
  );
  console.log(`[find-duplicates] ✅ done in ${secs}s`);
}

await main().catch((error: unknown) => {
  console.error("[find-duplicates] failed:", error);
  process.exitCode = 1;
});
