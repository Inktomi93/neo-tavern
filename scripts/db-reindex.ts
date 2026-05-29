import process from "node:process";
import { createDb } from "../src/db/client";
import { reindexAnn, VECTOR_TABLES } from "../src/db/vector-ops";
import { env } from "../src/server/env";

/**
 * Manual recovery: rebuild every libSQL ANN (DiskANN) index in place (`REINDEX`). Use when a DB
 * got into the poisoned shadow-table state — typically a historical bare `DELETE FROM` on a vector
 * table, which surfaces as "shadow row" errors on the next insert. Safe to run anytime; reads
 * stored vectors only, no model load / GPU. (The boot health check also recreates a fully-MISSING
 * index; this rebuilds an existing-but-corrupt one.)
 */
async function main(): Promise<void> {
  console.log(`[reindex] DB ${env.DATABASE_URL} · tables: ${VECTOR_TABLES.join(", ")}`);
  const db = await createDb(env.DATABASE_URL);
  const t0 = Date.now();
  await reindexAnn(db);
  console.log(
    `[reindex] ✅ rebuilt ${VECTOR_TABLES.length} ANN indexes in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

await main().catch((error: unknown) => {
  console.error("[reindex] failed:", error);
  process.exit(1);
});
