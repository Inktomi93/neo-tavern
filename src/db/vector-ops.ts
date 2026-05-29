import { sql } from "drizzle-orm";
import type { Db } from "./client";

// The tables carrying a libSQL native ANN (DiskANN) vector index. Each declares its index in the
// schema as `index("<table>_ann").on(sql`libsql_vector_idx(embedding)`)` (src/db/schema/search.ts),
// emitted into the baseline migration. The index name is uniformly `<table>_ann` and the column is
// uniformly `embedding`, so the DDL the ops below need is fully derivable from the table name —
// this list is the single source of truth.
export const VECTOR_TABLES = [
  "character_embeddings",
  "chat_digests",
  "chat_segments",
  "image_embeddings",
] as const;

export type VectorTable = (typeof VECTOR_TABLES)[number];

const annName = (table: VectorTable): string => `${table}_ann`;

// Identifiers here come only from the compile-time VECTOR_TABLES list (never user input), so raw
// interpolation is safe. CREATE INDEX takes an expression, not an identifier, so it can't be
// parameterized — `sql.raw` over the constant string is the correct tool.
const createAnnSql = (table: VectorTable): string =>
  `CREATE INDEX IF NOT EXISTS ${annName(table)} ON ${table} (libsql_vector_idx(embedding))`;

// THE safe way to empty a vector table. A bare `DELETE FROM <t>` trips SQLite's truncate
// optimization, which skips the per-row maintenance libSQL's DiskANN shadow table depends on →
// the shadow graph is left inconsistent and the *next* insert fails with a "shadow row" error.
// Dropping the ANN index first sidesteps that entirely (and a subsequent bulk re-embed is faster
// without per-insert graph maintenance); we then recreate the index. Use this anywhere a full
// wipe of a vector table is needed — never a bare bulk DELETE.
export async function clearVectorTable(db: Db, table: VectorTable): Promise<void> {
  await db.run(sql.raw(`DROP INDEX IF EXISTS ${annName(table)}`));
  await db.run(sql.raw(`DELETE FROM ${table}`));
  await db.run(sql.raw(createAnnSql(table)));
}

// Recovery for a DB already in the poisoned state (e.g. a historical bare `DELETE FROM`): rebuild
// the DiskANN graph in place. Pass a table to target one, or omit to reindex all vector tables.
export async function reindexAnn(db: Db, table?: VectorTable): Promise<void> {
  const targets = table ? [table] : VECTOR_TABLES;
  for (const t of targets) {
    await db.run(sql.raw(`REINDEX ${annName(t)}`));
  }
}

// Boot-time health check (called from the composition root after migrations). Every expected ANN
// index must exist; a missing one means a botched migration or a manual drop, and without this the
// failure surfaces cryptically at the first vector query instead of loudly at startup. Self-heals
// by recreating the index from its canonical DDL. Pure (no logging) so it respects the db-layer
// boundary — the caller logs the returned outcome.
export async function assertVectorIndexes(
  db: Db,
): Promise<{ missing: VectorTable[]; repaired: VectorTable[] }> {
  const rows = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'index'`,
  );
  const present = new Set(rows.map((r) => r.name));
  const missing: VectorTable[] = [];
  const repaired: VectorTable[] = [];
  for (const table of VECTOR_TABLES) {
    if (present.has(annName(table))) continue;
    missing.push(table);
    // The table itself exists (migrations ran) — recreate just the index from the known DDL.
    await db.run(sql.raw(createAnnSql(table)));
    repaired.push(table);
  }
  return { missing, repaired };
}
