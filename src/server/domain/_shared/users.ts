import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { users } from "../../../db/schema";
import { castId, type UserId } from "../../../shared/ids";
import { env } from "../../env";
import { getLog } from "../../observability/logger";
import { newId } from "./ids";

// Resolve a handle (X-Authentik-Username, or DEFAULT_USER_HANDLE) to a user row id,
// creating the row on first sight. This is where identity (a string) becomes a
// tenant (a row) — so the auth/trpc layers never touch the db. Single-user today =
// one row; multi-user later = unchanged.
export async function ensureUser(db: Db, handle: string): Promise<UserId> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  const found = existing[0];
  if (found) {
    return castId<UserId>(found.id);
  }
  const id = newId<UserId>();
  // The one access-control decision the app owns: any handle in OWNER_HANDLES (defaults to
  // [DEFAULT_USER_HANDLE]) is provisioned as admin; everyone else as "user". Uses ownerHandles()
  // — the SAME predicate provisionIdentity (SSO) uses — so both seams agree once OWNER_HANDLES
  // names more than one admin (previously this hardcoded DEFAULT_USER_HANDLE only and diverged).
  const role = ownerHandles().includes(handle) ? "admin" : "user";
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
  return castId<UserId>(after[0]?.id ?? id);
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
 * The SEAM-ONLY identity upsert for SSO modes (docs/auth/auth-and-credentials-plan.md §6). Called once at
 * the auth seam / OIDC callback — NOT a broadening of ensureUser (whose ~30 downstream callers only
 * have a handle and must keep working). Keys on the STABLE `externalId` when present (so a username
 * rename updates `handle` on the SAME row, never duplicates); else by handle.
 *
 * `role` is SEEDED from OWNER_GROUP/OWNER_HANDLES membership on INSERT, then admin-managed via
 * userAdmin.setRole — provisioning does NOT re-derive it on update, so a manual grant isn't clobbered
 * on the user's next login (and there's no per-request role churn). The owner is always admin (in
 * OWNER_HANDLES by default). Likewise `enabled` is NEVER reset on update — that would let a disabled
 * user re-enable themselves by logging in; only a fresh insert is enabled. Returns the row's id +
 * enabled + (stored) role so the seam can gate (disabled → reject) and populate ctx.auth.role.
 */
export async function provisionIdentity(
  db: Db,
  identity: { externalId: string | null; handle: string; groups: string[] },
): Promise<{ id: UserId; enabled: boolean; role: "admin" | "user" }> {
  const role = determineRole(identity.handle, identity.groups);
  const cols = {
    id: users.id,
    handle: users.handle,
    externalId: users.externalId,
    role: users.role,
    enabled: users.enabled,
  };
  // The exact shape `cols` selects — so `existing` is typed precisely (no $inferSelect cast that would
  // falsely claim the unselected displayName/createdAt columns exist on these rows).
  type ExistingRow = {
    id: string;
    handle: string;
    externalId: string | null;
    role: "admin" | "user";
    enabled: boolean;
  };

  // Match by the stable externalId first; fall back to handle (single-user rows / first SSO login of a
  // pre-existing handle).
  let existing: ExistingRow | undefined;
  if (identity.externalId) {
    existing = (
      await db.select(cols).from(users).where(eq(users.externalId, identity.externalId)).limit(1)
    ).at(0);
  }
  if (!existing) {
    existing = (
      await db.select(cols).from(users).where(eq(users.handle, identity.handle)).limit(1)
    ).at(0);
  }

  if (existing) {
    // Refresh handle (rename) + link a newly-seen externalId; preserve `role` (admin-managed) and
    // `enabled` (the admin disable lever).
    const patch: Partial<typeof users.$inferInsert> = {};
    if (identity.externalId && existing.externalId !== identity.externalId) {
      patch.externalId = identity.externalId;
    }
    if (existing.handle !== identity.handle) patch.handle = identity.handle;
    if (Object.keys(patch).length > 0) {
      await db.update(users).set(patch).where(eq(users.id, existing.id));
      getLog().info(
        { handle: identity.handle, externalId: identity.externalId },
        "user: provisioned SSO identity (updated)",
      );
    }
    return { id: castId<UserId>(existing.id), enabled: existing.enabled, role: existing.role };
  }

  const id = newId<UserId>();
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
  fn: (ownerId: UserId) => Promise<T>,
): Promise<T> {
  const ownerId = await ensureUser(db, username);
  return fn(ownerId);
}
