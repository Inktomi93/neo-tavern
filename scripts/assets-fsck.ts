import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import { createAssetsService } from "../src/server/domain/assets";
import { env } from "../src/server/env";
import { createCas } from "../src/server/storage/cas";

/**
 * Asset integrity check (composition-root CLI). For every `assets` row: assert the blob exists and
 * re-hashes to its name; report `dangling` (row, no blob), `corrupt` (row, blob fails verify), and
 * `orphan` (blob on disk, no row). With `--rebuild`, re-derive rows for orphan blobs (DR — walk +
 * hash the tree). Run: `pnpm assets:fsck [--rebuild]`.
 */
async function main(): Promise<void> {
  const rebuild = process.argv.includes("--rebuild");
  console.log(`[assets:fsck] ${env.ASSETS_DIR}${rebuild ? " · --rebuild" : ""}`);

  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);
  const assets = createAssetsService(db, createCas(env.ASSETS_DIR));

  const r = await assets.fsck();
  console.log(
    `[assets:fsck] ${r.rows} rows · ${r.ok} ok · ${r.dangling.length} dangling · ${r.corrupt.length} corrupt · ${r.orphans.length} orphan blobs`,
  );
  if (r.dangling.length > 0)
    console.warn(`[assets:fsck] dangling (row, no blob): ${r.dangling.join(", ")}`);
  if (r.corrupt.length > 0)
    console.warn(`[assets:fsck] corrupt (blob ≠ hash): ${r.corrupt.join(", ")}`);
  if (r.orphans.length > 0)
    console.warn(`[assets:fsck] orphan blobs (no row): ${r.orphans.join(", ")}`);

  if (rebuild && r.orphans.length > 0) {
    const rb = await assets.rebuildFromTree("card");
    console.log(`[assets:fsck] rebuilt ${rb.created} rows (${rb.existing} already present)`);
  }
}

await main().catch((error: unknown) => {
  console.error("[assets:fsck] failed:", error);
  process.exitCode = 1;
});
