import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { freshDb } from "../../../../tests/support/db";
import { users } from "../../../db/schema";
import type { SessionId, UserId } from "../../../shared/ids";
import { verifyPassword } from "../../auth/password";
import { DomainForbiddenError, DomainOperationError } from "../_shared/errors";
import { ensureUser } from "../_shared/users";
import { type AdminService, createAdminService, type SessionAdminPort } from "./service";

// A stub session port — records revoke-all calls so resetPassword's session-kick is observable.
function stubSessions(): SessionAdminPort & { revoked: UserId[] } {
  const revoked: UserId[] = [];
  return {
    revoked,
    listForUser: async () => [],
    revoke: async (_id: SessionId) => {},
    revokeAllForUser: async (id: UserId) => {
      revoked.push(id);
      return 0;
    },
  };
}

let admin: AdminService;
let sessions: ReturnType<typeof stubSessions>;
let db: Awaited<ReturnType<typeof freshDb>>;

beforeEach(async () => {
  db = await freshDb();
  sessions = stubSessions();
  admin = createAdminService(db, sessions);
  await ensureUser(db, "owner"); // DEFAULT_USER_HANDLE → admin, so requireAdmin("owner") passes
});

describe("admin.createUser", () => {
  test("mints a local user with a working password and the requested role", async () => {
    const created = await admin.createUser({
      username: "owner",
      handle: "alice",
      password: "alice-pass-1",
      role: "user",
    });
    expect(created.handle).toBe("alice");
    expect(created.role).toBe("user");
    const row = (
      await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, created.id))
    )[0];
    expect(await verifyPassword("alice-pass-1", row?.h ?? null)).toBe(true);
    expect(await verifyPassword("wrong", row?.h ?? null)).toBe(false);
  });

  test("rejects a duplicate handle", async () => {
    await admin.createUser({
      username: "owner",
      handle: "bob",
      password: "bob-pass-1",
      role: "user",
    });
    await expect(
      admin.createUser({ username: "owner", handle: "bob", password: "other-pass", role: "user" }),
    ).rejects.toBeInstanceOf(DomainOperationError);
  });

  test("a non-admin caller is forbidden", async () => {
    await ensureUser(db, "bystander"); // role "user"
    await expect(
      admin.createUser({ username: "bystander", handle: "x", password: "xxxxxxxx", role: "user" }),
    ).rejects.toBeInstanceOf(DomainForbiddenError);
  });
});

describe("admin.resetPassword", () => {
  test("changes the password and revokes the user's sessions", async () => {
    const created = await admin.createUser({
      username: "owner",
      handle: "carol",
      password: "carol-old-1",
      role: "user",
    });
    await admin.resetPassword({
      username: "owner",
      userId: created.id,
      newPassword: "carol-new-2",
    });
    const row = (
      await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, created.id))
    )[0];
    expect(await verifyPassword("carol-new-2", row?.h ?? null)).toBe(true);
    expect(await verifyPassword("carol-old-1", row?.h ?? null)).toBe(false);
    expect(sessions.revoked).toContain(created.id);
  });
});
