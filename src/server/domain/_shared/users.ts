import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { users } from "../../../db/schema";
import { env } from "../../env";
import { getLog } from "../../observability/logger";
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
  // The one access-control decision the app owns: the owner (DEFAULT_USER_HANDLE) is provisioned as
  // admin; everyone else as "user". Idempotent — covers the fresh-DB owner-first-login case without
  // a separate seed; authentik remains the real gate for who reaches this point at all.
  const role = handle === env.DEFAULT_USER_HANDLE ? "admin" : "user";
  await db.insert(users).values({ id, handle, role, createdAt: Date.now() }).onConflictDoNothing();
  // Identity → tenant: a new user row appeared. Rare + notable (esp. under multi-user) —
  // the handle is an identity label, not RP content, so it's safe to log.
  getLog().info({ handle }, "user: created tenant row");
  // Re-read to tolerate a concurrent insert that won the race.
  const after = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  return after[0]?.id ?? id;
}

export async function withOwner<T>(
  db: Db,
  username: string,
  fn: (ownerId: string) => Promise<T>,
): Promise<T> {
  const ownerId = await ensureUser(db, username);
  return fn(ownerId);
}
