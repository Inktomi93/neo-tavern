import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { users } from "../../../db/schema";
import { newId } from "./ids";

// Resolve a handle (X-Authentik-Username, or DEFAULT_USER_HANDLE) to a user row id,
// creating the row on first sight. This is where identity (a string) becomes a
// tenant (a row) — so the auth/trpc layers never touch the db. Single-user today =
// one row; multi-user later = unchanged.
export async function ensureUser(db: Db, handle: string): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  const found = existing[0];
  if (found) {
    return found.id;
  }
  const id = newId();
  await db.insert(users).values({ id, handle, createdAt: Date.now() }).onConflictDoNothing();
  // Re-read to tolerate a concurrent insert that won the race.
  const after = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  return after[0]?.id ?? id;
}
