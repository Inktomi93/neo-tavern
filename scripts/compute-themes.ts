import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import { computeThemes } from "../src/server/domain/corpus";
import { createSummarizer } from "../src/server/embeddings/summarizer";
import { env } from "../src/server/env";

/**
 * Emergent theme precompute (Pillar B — docs/planning/breadth-buildout.md B.4). k-means over the tier-0
 * digest embeddings → name each cluster with the (grammar-constrained) summarizer → fill `theme_clusters`
 * + `digest_theme_assignments`, and backfill `chat_digests.msg_mid_at` (the timeline axis). Run after
 * `pnpm memory:backfill`; honors the local GGUF summarizer (SUMMARIZER_GGUF) else hosted Haiku.
 *
 *   pnpm compute-themes            # k=30
 *   pnpm compute-themes --k 24     # tune k (compare inertia for the elbow)
 */
async function main(): Promise<void> {
  const kArg = process.argv.indexOf("--k");
  const k = kArg >= 0 ? Number(process.argv[kArg + 1]) : 30;
  console.log(`[themes] DB ${env.DATABASE_URL} · k=${k}`);

  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);
  const summarizer = createSummarizer();

  const t0 = Date.now();
  const stats = await computeThemes(db, { summarizer }, { k });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(
    `[themes] ${stats.clusters} clusters · ${stats.digestsClustered} digests assigned ` +
      `· inertia ${stats.inertia.toFixed(1)} · ${stats.msgMidAtBackfilled} msgMidAt backfilled`,
  );
  console.log(`[themes] ✅ done in ${secs}s`);
}

await main().catch((error: unknown) => {
  console.error("[themes] failed:", error);
  process.exitCode = 1;
});
