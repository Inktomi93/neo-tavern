import { and, eq } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "../../../db/client";

export function stripUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key as keyof T] = value as T[keyof T];
    }
  }
  return result;
}

type OwnedTable = SQLiteTable & {
  id: AnySQLiteColumn;
  ownerId: AnySQLiteColumn;
};

export async function fetchOwned<TRow>(
  db: Db,
  table: OwnedTable,
  id: string,
  ownerId: string,
): Promise<TRow | undefined> {
  const result = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.ownerId, ownerId)))
    .limit(1);
  return result[0] as TRow | undefined;
}
