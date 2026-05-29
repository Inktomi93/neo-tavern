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

// The owner-handle allowlist for admin determination (§6). OWNER_HANDLES (comma-list) overrides;
// unset ⇒ just the DEFAULT_USER_HANDLE (the single-user owner).
function ownerHandles(): string[] {
  const raw = env.OWNER_HANDLES;
  if (raw && raw.trim().length > 0) {
    return raw
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
  }
  return [env.DEFAULT_USER_HANDLE];
}

// admin iff (the identity is in OWNER_GROUP) OR (its handle ∈ OWNER_HANDLES) — group preferred, mirrors
// the stack's Grafana role-mapping convention. Everyone else is "user" (no escalation-by-default).
function determineRole(handle: string, groups: string[]): "admin" | "user" {
  if (env.OWNER_GROUP && groups.includes(env.OWNER_GROUP)) return "admin";
  if (ownerHandles().includes(handle)) return "admin";
  return "user";
}

/**
 * The SEAM-ONLY identity upsert for SSO modes (docs/auth-and-credentials-plan.md §6). Called once at
 * the auth seam / OIDC callback — NOT a broadening of ensureUser (whose ~30 downstream callers only
 * have a handle and must keep working). Keys on the STABLE `externalId` when present (so a username
 * rename updates `handle` on the SAME row, never duplicates); else by handle. Sets `role` from the
 * current group/handle membership and links a newly-seen externalId. NEVER resets `enabled` on an
 * existing row — that would let a disabled user re-enable themselves by logging in; only a fresh
 * insert is enabled. Returns the row's id + enabled + role so the seam can gate (disabled → reject).
 */
export async function provisionIdentity(
  db: Db,
  identity: { externalId: string | null; handle: string; groups: string[] },
): Promise<{ id: string; enabled: boolean; role: "admin" | "user" }> {
  const role = determineRole(identity.handle, identity.groups);
  const cols = {
    id: users.id,
    handle: users.handle,
    externalId: users.externalId,
    role: users.role,
    enabled: users.enabled,
  };

  // Match by the stable externalId first; fall back to handle (single-user rows / first SSO login of a
  // pre-existing handle).
  let existing: typeof users.$inferSelect | undefined;
  if (identity.externalId) {
    existing = (
      await db.select(cols).from(users).where(eq(users.externalId, identity.externalId)).limit(1)
    )[0] as typeof users.$inferSelect | undefined;
  }
  if (!existing) {
    existing = (
      await db.select(cols).from(users).where(eq(users.handle, identity.handle)).limit(1)
    )[0] as typeof users.$inferSelect | undefined;
  }

  if (existing) {
    // Refresh only what changed; preserve `enabled` (the admin disable lever).
    const patch: Partial<typeof users.$inferInsert> = {};
    if (identity.externalId && existing.externalId !== identity.externalId) {
      patch.externalId = identity.externalId;
    }
    if (existing.handle !== identity.handle) patch.handle = identity.handle;
    if (existing.role !== role) patch.role = role;
    if (Object.keys(patch).length > 0) {
      await db.update(users).set(patch).where(eq(users.id, existing.id));
      getLog().info(
        { handle: identity.handle, externalId: identity.externalId, role },
        "user: provisioned SSO identity (updated)",
      );
    }
    return { id: existing.id, enabled: existing.enabled, role };
  }

  const id = newId();
  await db.insert(users).values({
    id,
    handle: identity.handle,
    externalId: identity.externalId,
    role,
    enabled: true,
    createdAt: Date.now(),
  });
  getLog().info(
    { handle: identity.handle, externalId: identity.externalId, role },
    "user: provisioned SSO identity (created)",
  );
  return { id, enabled: true, role };
}

export async function withOwner<T>(
  db: Db,
  username: string,
  fn: (ownerId: string) => Promise<T>,
): Promise<T> {
  const ownerId = await ensureUser(db, username);
  return fn(ownerId);
}
