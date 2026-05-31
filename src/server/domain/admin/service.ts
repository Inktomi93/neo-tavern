import { and, asc, count, eq, ne } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { users } from "../../../db/schema";
import { castId, type SessionId, type UserId } from "../../../shared/ids";
import type { SessionView } from "../../../shared/session";
import { hashPassword } from "../../auth/password";
import { getLog } from "../../observability/logger";
import { requireAdmin } from "../_shared/admin";
import { DomainNotFoundError, DomainOperationError } from "../_shared/errors";
import { newId } from "../_shared/ids";

// The slice of the sessions service admin depends on, declared as a PORT (dependency inversion) so
// admin doesn't import a sibling feature (domain-no-cross-feature). The composition root injects the
// real SessionsService, which satisfies this structurally.
export interface SessionAdminPort {
  listForUser(userId: UserId): Promise<SessionView[]>;
  revoke(sessionId: SessionId): Promise<void>;
  revokeAllForUser(userId: UserId): Promise<number>;
}

// User administration (docs/auth/auth-and-credentials-plan.md §6) — the multi-user management surface,
// every method admin-gated (requireAdmin, defense-in-depth even though the tRPC adminProcedure also
// gates). Session listing/revocation lands in commit 4 (it needs the sessions service). No UI here.

export interface AdminUserView {
  id: UserId;
  handle: string;
  externalId: string | null;
  displayName: string | null;
  role: "admin" | "user";
  enabled: boolean;
  createdAt: number;
}

export interface AdminService {
  listUsers(params: { username: string }): Promise<AdminUserView[]>;
  setRole(params: {
    username: string;
    userId: UserId;
    role: "admin" | "user";
  }): Promise<AdminUserView>;
  setEnabled(params: {
    username: string;
    userId: UserId;
    enabled: boolean;
  }): Promise<AdminUserView>;
  listSessions(params: { username: string; userId: UserId }): Promise<SessionView[]>;
  revokeSession(params: { username: string; sessionId: SessionId }): Promise<void>;
  revokeUserSessions(params: { username: string; userId: UserId }): Promise<{ revoked: number }>;
  // Local-password (AUTH_MODE=local) user management. Admin-gated; the owner uses resetPassword on
  // their own row to change the env-seeded password. (Non-admin self-service password change is a
  // later authed-router addition, once the frontend exists.)
  createUser(params: {
    username: string;
    handle: string;
    password: string;
    role: "admin" | "user";
  }): Promise<AdminUserView>;
  resetPassword(params: { username: string; userId: UserId; newPassword: string }): Promise<void>;
}

const userCols = {
  id: users.id,
  handle: users.handle,
  externalId: users.externalId,
  displayName: users.displayName,
  role: users.role,
  enabled: users.enabled,
  createdAt: users.createdAt,
};

export function createAdminService(db: Db, sessionsService: SessionAdminPort): AdminService {
  // Lockout guard primitive: would this mutation leave the system with zero enabled admins?
  // Counts admins OTHER than `excludeUserId` who are still enabled — if that's 0, the caller is
  // about to remove the last admin and we refuse. (Both setRole's demote and setEnabled's
  // disable funnel through this so the rule is in one place.)
  async function otherEnabledAdminCount(excludeUserId: UserId): Promise<number> {
    const rows = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.enabled, true), ne(users.id, excludeUserId)));
    return rows[0]?.n ?? 0;
  }

  async function loadUser(userId: UserId): Promise<AdminUserView> {
    const rows = await db.select(userCols).from(users).where(eq(users.id, userId)).limit(1);
    const row = rows[0];
    if (!row) throw new DomainNotFoundError("user", userId);
    return { ...row, id: castId<UserId>(row.id) };
  }

  async function listUsers(params: { username: string }): Promise<AdminUserView[]> {
    await requireAdmin(db, params.username);
    const rows = await db.select(userCols).from(users).orderBy(asc(users.createdAt));
    return rows.map((r) => ({ ...r, id: castId<UserId>(r.id) }));
  }

  async function setRole(params: {
    username: string;
    userId: UserId;
    role: "admin" | "user";
  }): Promise<AdminUserView> {
    await requireAdmin(db, params.username);
    // Last-admin guard: demoting the only enabled admin to "user" would lock the system out of
    // its admin surfaces (no undo without a DB edit). Refuse and surface a typed error.
    if (params.role === "user") {
      const current = await loadUser(params.userId); // throws NotFound if the id is bogus
      if (current.role === "admin" && current.enabled) {
        if ((await otherEnabledAdminCount(params.userId)) === 0) {
          throw new DomainOperationError(
            "last_admin",
            "cannot demote the last admin — promote another user first",
          );
        }
      }
    }
    await db.update(users).set({ role: params.role }).where(eq(users.id, params.userId));
    getLog().info({ userId: params.userId, role: params.role }, "admin: set user role");
    return loadUser(params.userId);
  }

  async function setEnabled(params: {
    username: string;
    userId: UserId;
    enabled: boolean;
  }): Promise<AdminUserView> {
    const adminId = await requireAdmin(db, params.username);
    // Lockout guard: an admin can't disable their own account.
    if (adminId === params.userId && !params.enabled) {
      throw new DomainOperationError("cannot_disable_self", "you cannot disable your own account");
    }
    // Last-admin guard: disabling another enabled admin is fine only if at least one enabled
    // admin remains. (The self-disable case is already blocked above, so excluding self here is
    // about disabling someone ELSE who happens to be the only other admin.)
    if (!params.enabled) {
      const target = await loadUser(params.userId);
      if (target.role === "admin" && target.enabled) {
        if ((await otherEnabledAdminCount(params.userId)) === 0) {
          throw new DomainOperationError(
            "last_admin",
            "cannot disable the last admin — promote another user first",
          );
        }
      }
    }
    await db.update(users).set({ enabled: params.enabled }).where(eq(users.id, params.userId));
    // Disable kills the user's live sessions NOW (belt-and-suspenders with the per-request enabled
    // gate in sessions.validate / the seam) so a ban is immediate, not deferred to session expiry.
    if (!params.enabled) {
      await sessionsService.revokeAllForUser(params.userId);
    }
    getLog().info({ userId: params.userId, enabled: params.enabled }, "admin: set user enabled");
    return loadUser(params.userId);
  }

  async function listSessions(params: {
    username: string;
    userId: UserId;
  }): Promise<SessionView[]> {
    await requireAdmin(db, params.username);
    return sessionsService.listForUser(params.userId);
  }

  async function revokeSession(params: { username: string; sessionId: SessionId }): Promise<void> {
    await requireAdmin(db, params.username);
    await sessionsService.revoke(params.sessionId);
  }

  async function revokeUserSessions(params: {
    username: string;
    userId: UserId;
  }): Promise<{ revoked: number }> {
    await requireAdmin(db, params.username);
    return { revoked: await sessionsService.revokeAllForUser(params.userId) };
  }

  async function createUser(params: {
    username: string;
    handle: string;
    password: string;
    role: "admin" | "user";
  }): Promise<AdminUserView> {
    await requireAdmin(db, params.username);
    const handle = params.handle.trim();
    if (!handle) {
      throw new DomainOperationError("invalid_handle", "handle must not be empty");
    }
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1);
    if (existing[0]) {
      throw new DomainOperationError(
        "user_exists",
        `a user with handle "${handle}" already exists`,
      );
    }
    // hashPassword enforces MIN_PASSWORD_LENGTH (throws) → surface as a domain operation error.
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(params.password);
    } catch (err) {
      throw new DomainOperationError("weak_password", err instanceof Error ? err.message : "weak");
    }
    const id = newId<UserId>();
    await db
      .insert(users)
      .values({ id, handle, role: params.role, passwordHash, createdAt: Date.now() });
    getLog().info({ userId: id, handle, role: params.role }, "admin: created local user");
    return loadUser(id);
  }

  async function resetPassword(params: {
    username: string;
    userId: UserId;
    newPassword: string;
  }): Promise<void> {
    await requireAdmin(db, params.username);
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(params.newPassword);
    } catch (err) {
      throw new DomainOperationError("weak_password", err instanceof Error ? err.message : "weak");
    }
    await db.update(users).set({ passwordHash }).where(eq(users.id, params.userId));
    // A password reset kicks the user's live sessions → they must log in again with the new password.
    await sessionsService.revokeAllForUser(params.userId);
    getLog().info({ userId: params.userId }, "admin: reset local user password");
  }

  return {
    listUsers,
    setRole,
    setEnabled,
    listSessions,
    revokeSession,
    revokeUserSessions,
    createUser,
    resetPassword,
  };
}
