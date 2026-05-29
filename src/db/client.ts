import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "./schema";

export type Db = LibSQLDatabase<typeof schema>;

// Per-connection PRAGMAs. `foreign_keys` is OFF by default in SQLite and is
// per-connection — our schema is FK-dense, so this is load-bearing, not cosmetic.
// WAL + busy_timeout + synchronous=NORMAL is the standard production tuning.
const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA cache_size = -1048576", // 1GB cache (negative is KiB)
  "PRAGMA mmap_size = 2147483648", // 2GB memory-mapped I/O
  "PRAGMA temp_store = MEMORY",
].join("; ");

const MIGRATIONS_DIR = fileURLToPath(new URL("migrations", import.meta.url));

// Path-agnostic factory (layer cake: `db` can't read `env`). The server passes
// `env.DATABASE_URL`; tests pass ":memory:".
export async function createDb(url: string): Promise<Db> {
  const client = createClient({ url });
  await client.executeMultiple(PRAGMAS);
  return drizzle(client, { schema });
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

export async function optimizeDb(db: Db): Promise<void> {
  await db.run(sql`PRAGMA optimize`);
}
