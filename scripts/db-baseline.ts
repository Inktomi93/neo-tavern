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

  // Safety: this is for a POPULATED DB. If core tables are absent, the operator wants a real
  // migrate (server boot / runMigrations), not a baseline-mark that would mask an unmigrated DB.
  const core = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`,
  );
  if (core.length === 0) {
    throw new Error(
      "DB has no `users` table — it looks empty/unmigrated. Baseline-mark is only for a DB already " +
        "built by the pre-squash migrations. For a fresh DB just start the server (runMigrations).",
    );
  }

  // drizzle's own bookkeeping table DDL (matches drizzle-orm/libsql migrator).
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );

  const existing = await db.all<{ hash: string; created_at: number }>(
    sql`SELECT hash, created_at FROM __drizzle_migrations`,
  );
  const alreadyBaselined =
    existing.length === 1 &&
    existing[0]?.hash === hash &&
    Number(existing[0]?.created_at) === baseline.when;
  if (alreadyBaselined) {
    console.log("[baseline] ✅ already baselined — no change.");
    process.exit(0);
  }

  // Replace whatever is there (the 27 old rows, or a partial state) with the single baseline row.
  await db.run(sql`DELETE FROM __drizzle_migrations`);
  await db.run(
    sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${baseline.when})`,
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
