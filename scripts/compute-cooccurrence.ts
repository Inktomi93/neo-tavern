import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import { computeCooccurrence } from "../src/server/domain/corpus";
import { env } from "../src/server/env";

/**
 * Keyword co-occurrence precompute (Pillar A — docs/planning/breadth-buildout.md B.3). Fill
 * `keyword_cooccurrence` + `character_keyword_profiles` from tier-0 digest keywords (content-collapsed,
 * hub-token-filtered). Pure SQL/JS — no GPU. Run after `pnpm memory:backfill`; re-run when chats change.
 *
 *   pnpm compute-cooccurrence
 */
async function main(): Promise<void> {
  console.log(`[cooccurrence] DB ${env.DATABASE_URL}`);
  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);

  const t0 = Date.now();
  const stats = await computeCooccurrence(db);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(
    `[cooccurrence] ${stats.pairs} keyword pairs · ${stats.charKeywords} character-keyword rows ` +
      `· ${stats.hubTokensDropped} hub tokens dropped`,
  );
  console.log(`[cooccurrence] ✅ done in ${secs}s`);
}

await main().catch((error: unknown) => {
  console.error("[cooccurrence] failed:", error);
  process.exitCode = 1;
});
