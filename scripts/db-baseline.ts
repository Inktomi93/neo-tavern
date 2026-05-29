import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { env } from "../src/server/env";

/**
 * ONE-TIME baseline-mark for an EXISTING, populated DB after the migrations were squashed to a
 * single baseline (src/db/migrations/0000_baseline.sql).
 *
 * The DB already has every table + ANN index (built by the old 0000–0026 chain). Its
 * `__drizzle_migrations` table still lists those 27 old hashes, whose max `created_at` is LESS
 * than the new baseline's `when` — so drizzle's migrator (skip logic is purely timestamp-based)
 * would try to APPLY the baseline and collide on `CREATE TABLE`. This script reconciles
 * `__drizzle_migrations` to a single row matching the baseline (correct hash + the baseline's
 * `when`), so `runMigrations()` (server boot) sees it as already applied and runs ZERO DDL.
 *
 * Fresh DBs / tests never need this — an empty `__drizzle_migrations` makes the migrator run the
 * baseline normally. Idempotent: re-running on an already-baselined DB is a no-op. Run with
 * `pnpm db:baseline` once per existing DB (local + the homelab prod DB on the deploy that ships
 * the squash). BACK UP THE DB FIRST.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

async function main(): Promise<void> {
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, "utf8")) as {
    entries: JournalEntry[];
  };

  if (journal.entries.length !== 1) {
    throw new Error(
      `Expected exactly one (baseline) migration in the journal, found ${journal.entries.length}. ` +
        "This script is only for the squashed single-baseline state.",
    );
  }
  const baseline = journal.entries[0];
  if (baseline === undefined) throw new Error("journal has no entries");

  // drizzle hashes the FULL raw .sql file contents with sha256 (drizzle-orm/migrator
  // readMigrationFiles). Match it exactly so the stored hash is correct.
  const sqlText = readFileSync(`${MIGRATIONS_DIR}/${baseline.tag}.sql`, "utf8");
  const hash = createHash("sha256").update(sqlText).digest("hex");

  console.log(`[baseline] DB ${env.DATABASE_URL}`);
  console.log(
    `[baseline] baseline=${baseline.tag} when=${baseline.when} hash=${hash.slice(0, 12)}…`,
  );

  const db = await createDb(env.DATABASE_URL);

  // Safety: baseline-mark is ONLY valid on a DB already at the pre-squash HEAD — i.e. every table
  // the baseline creates is present. Marking a DB that's empty or stranded mid-chain would record
  // it as "fully migrated" while it's missing later tables → silent corruption. So verify the live
  // schema has EVERY table the baseline declares, and refuse otherwise (a fresh/partial DB should
  // just run the migrator: start the server / runMigrations).
  const expectedTables = [...sqlText.matchAll(/CREATE TABLE `([^`]+)`/g)]
    .map((m) => m[1])
    .filter((t): t is string => t !== undefined);
  const liveRows = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
  );
  const live = new Set(liveRows.map((r) => r.name));
  const missing = expectedTables.filter((t) => !live.has(t));
  if (missing.length > 0) {
    throw new Error(
      `DB is missing ${missing.length}/${expectedTables.length} table(s) the baseline expects ` +
        `(e.g. ${missing.slice(0, 5).join(", ")}). It is empty or stranded mid-migration — ` +
        "baseline-mark would mask that. Bring it to HEAD with the migrator (start the server / " +
        "runMigrations) first; this script is only for a DB already built by the full pre-squash chain.",
    );
  }

  // drizzle's own bookkeeping table DDL (matches drizzle-orm/libsql migrator).
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );

  const existing = await db.all<{ hash: string; created_at: number }>(
    sql`SELECT hash, created_at FROM __drizzle_migrations`,
  );
  // Idempotent: a single row for this baseline whose timestamp already clears the skip threshold
  // (migrator skips iff lastDbMigration.created_at < entry.when) needs no rewrite.
  const alreadyBaselined =
    existing.length === 1 &&
    existing[0]?.hash === hash &&
    Number(existing[0]?.created_at) >= baseline.when;
  if (alreadyBaselined) {
    console.log("[baseline] ✅ already baselined — no change.");
    process.exit(0);
  }

  // Marker `created_at` = "applied now" in the repo's canonical epoch-ms UTC (Date.now(), same as
  // every other timestamp we write). It must be STRICTLY greater than the baseline's `when` so the
  // migrator skips it regardless of whether the comparator is `<` or `<=`; the `when + 1` floor
  // guarantees that even under backwards clock skew.
  const markerCreatedAt = Math.max(Date.now(), baseline.when + 1);
  // Replace whatever is there (the 27 old rows, or a partial state) with the single baseline row.
  await db.run(sql`DELETE FROM __drizzle_migrations`);
  await db.run(
    sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${markerCreatedAt})`,
  );

  console.log(
    `[baseline] ✅ reconciled __drizzle_migrations → 1 baseline row (was ${existing.length}). ` +
      "runMigrations() will now no-op on this DB.",
  );
}

await main().catch((error: unknown) => {
  console.error("[baseline] failed:", error);
  process.exit(1);
});
