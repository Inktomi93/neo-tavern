import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import { computeCharacterSummaries } from "../src/server/domain/corpus";
import { createSummarizer } from "../src/server/embeddings/summarizer";
import { env } from "../src/server/env";

/**
 * Character distillation (card-curator classify_genre + summarize_card — B.0). A grammar-constrained
 * pass over each character's CURRENT-version card → genre/tone/tags + elevator pitch + overview, so the
 * library becomes filterable (analytics.characters / characterSummary). Honors the local GGUF summarizer
 * (SUMMARIZER_GGUF) else hosted Haiku. Re-run after card edits / version bumps.
 *
 *   pnpm distill-characters
 */
async function main(): Promise<void> {
  console.log(`[distill] DB ${env.DATABASE_URL}`);
  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);

  const t0 = Date.now();
  const stats = await computeCharacterSummaries(db, { summarizer: createSummarizer() });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[distill] ${stats.distilled} distilled · ${stats.failed} failed · ${secs}s`);
}

await main().catch((error: unknown) => {
  console.error("[distill] failed:", error);
  process.exitCode = 1;
});
