import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import { createAssetsService } from "../src/server/domain/assets";
import { env } from "../src/server/env";
import { createCas } from "../src/server/storage/cas";

/**
 * Asset garbage collection (composition-root CLI). Mark-sweep: the referenced set = every asset
 * reachable via a character_versions / personas avatarAssetId; on-disk blobs NOT in that set are
 * orphans and get swept — EXCEPT blobs younger than the grace window (default 1h), so GC can't race
 * an in-flight import that stored a blob but hasn't linked it yet. Manual/scheduled, never automatic.
 * Run: `pnpm assets:gc [graceMinutes]` (default 60).
 */
async function main(): Promise<void> {
  const graceMinutes = Number(process.argv[2] ?? "60") || 60;
  const graceMs = graceMinutes * 60_000;
  console.log(`[assets:gc] ${env.ASSETS_DIR} · grace ${graceMinutes}m`);

  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);
  const assets = createAssetsService(db, createCas(env.ASSETS_DIR));

  const r = await assets.collectGarbage({ graceMs });
  console.log(
    `[assets:gc] ✅ scanned ${r.scanned} · removed ${r.removed} · kept ${r.keptReferenced} referenced + ${r.keptWithinGrace} within grace`,
  );
}

await main().catch((error: unknown) => {
  console.error("[assets:gc] failed:", error);
  process.exitCode = 1;
});
