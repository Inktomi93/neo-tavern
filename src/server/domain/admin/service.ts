import { asc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { users } from "../../../db/schema";
import type { SessionView } from "../../../shared/session";
import { getLog } from "../../observability/logger";
import { requireAdmin } from "../_shared/admin";
import { DomainNotFoundError, DomainOperationError } from "../_shared/errors";

// The slice of the sessions service admin depends on, declared as a PORT (dependency inversion) so
// admin doesn't import a sibling feature (domain-no-cross-feature). The composition root injects the
// real SessionsService, which satisfies this structurally.
export interface SessionAdminPort {
  listForUser(userId: string): Promise<SessionView[]>;
  revoke(sessionId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<number>;
}

// User administration (docs/auth/auth-and-credentials-plan.md §6) — the multi-user management surface,
// every method admin-gated (requireAdmin, defense-in-depth even though the tRPC adminProcedure also
// gates). Session listing/revocation lands in commit 4 (it needs the sessions service). No UI here.

export interface AdminUserView {
  id: string;
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
    userId: string;
    role: "admin" | "user";
  }): Promise<AdminUserView>;
  setEnabled(params: {
    username: string;
    userId: string;
    enabled: boolean;
  }): Promise<AdminUserView>;
  listSessions(params: { username: string; userId: string }): Promise<SessionView[]>;
  revokeSession(params: { username: string; sessionId: string }): Promise<void>;
  revokeUserSessions(params: { username: string; userId: string }): Promise<{ revoked: number }>;
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
  async function loadUser(userId: string): Promise<AdminUserView> {
    const rows = await db.select(userCols).from(users).where(eq(users.id, userId)).limit(1);
    const row = rows[0];
    if (!row) throw new DomainNotFoundError("user", userId);
    return row;
  }

  async function listUsers(params: { username: string }): Promise<AdminUserView[]> {
    await requireAdmin(db, params.username);
    return db.select(userCols).from(users).orderBy(asc(users.createdAt));
  }

  async function setRole(params: {
    username: string;
    userId: string;
    role: "admin" | "user";
  }): Promise<AdminUserView> {
    await requireAdmin(db, params.username);
    await db.update(users).set({ role: params.role }).where(eq(users.id, params.userId));
    getLog().info({ userId: params.userId, role: params.role }, "admin: set user role");
    return loadUser(params.userId);
  }

  async function setEnabled(params: {
    username: string;
    userId: string;
    enabled: boolean;
  }): Promise<AdminUserView> {
    const adminId = await requireAdmin(db, params.username);
    // Lockout guard: an admin can't disable their own account.
    if (adminId === params.userId && !params.enabled) {
      throw new DomainOperationError("cannot_disable_self", "you cannot disable your own account");
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
    userId: string;
  }): Promise<SessionView[]> {
    await requireAdmin(db, params.username);
    return sessionsService.listForUser(params.userId);
  }

  async function revokeSession(params: { username: string; sessionId: string }): Promise<void> {
    await requireAdmin(db, params.username);
    await sessionsService.revoke(params.sessionId);
  }

  async function revokeUserSessions(params: {
    username: string;
    userId: string;
  }): Promise<{ revoked: number }> {
    await requireAdmin(db, params.username);
    return { revoked: await sessionsService.revokeAllForUser(params.userId) };
  }

  return {
    listUsers,
    setRole,
    setEnabled,
    listSessions,
    revokeSession,
    revokeUserSessions,
  };
}
