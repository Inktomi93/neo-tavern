import { createDb, type Db, runMigrations } from "../../src/db/client";

// Fresh in-memory libSQL with migrations applied. Per tests/AGENTS.md: call per test
// (not a shared singleton) so each test gets an isolated database.
export async function freshDb(): Promise<Db> {
  const db = await createDb(":memory:");
  await runMigrations(db);
  return db;
}
