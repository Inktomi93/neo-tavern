import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db, runMigrations } from "../../../db/client";
import { users } from "../../../db/schema";
import { env } from "../../env";
import { requireAdmin } from "./admin";
import { DomainForbiddenError } from "./errors";
import { ensureUser, provisionIdentity } from "./users";

let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
  await runMigrations(db);
});

async function roleOf(id: string): Promise<string | undefined> {
  const rows = await db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
  return rows[0]?.role;
}

describe("ensureUser role assignment (the production provisioning path)", () => {
  test("the owner handle (DEFAULT_USER_HANDLE) is provisioned as admin", async () => {
    const id = await ensureUser(db, env.DEFAULT_USER_HANDLE);
    expect(await roleOf(id)).toBe("admin");
  });

  test("any other handle is provisioned as a plain user (no escalation-by-default)", async () => {
    const id = await ensureUser(db, "someone-else");
    expect(await roleOf(id)).toBe("user");
  });

  test("re-provisioning is idempotent (same id, role unchanged)", async () => {
    const first = await ensureUser(db, "someone-else");
    const second = await ensureUser(db, "someone-else");
    expect(second).toBe(first);
    expect(await roleOf(first)).toBe("user");
  });
});

describe("provisionIdentity (the SSO seam upsert)", () => {
  test("a new SSO identity creates a row keyed on externalId; the owner handle is admin", async () => {
    const r = await provisionIdentity(db, {
      externalId: "ext-owner",
      handle: env.DEFAULT_USER_HANDLE,
      groups: [],
    });
    expect(r.role).toBe("admin");
    expect(r.enabled).toBe(true);
    const rows = await db
      .select({ externalId: users.externalId })
      .from(users)
      .where(eq(users.id, r.id))
      .limit(1);
    expect(rows[0]?.externalId).toBe("ext-owner");
  });

  test("a non-owner SSO identity is a plain user", async () => {
    const r = await provisionIdentity(db, { externalId: "ext-a", handle: "alice", groups: [] });
    expect(r.role).toBe("user");
  });

  test("a username rename (same externalId, new handle) updates the SAME row — no duplicate", async () => {
    const first = await provisionIdentity(db, {
      externalId: "ext-a",
      handle: "alice",
      groups: [],
    });
    const renamed = await provisionIdentity(db, {
      externalId: "ext-a",
      handle: "alice-renamed",
      groups: [],
    });
    expect(renamed.id).toBe(first.id);
    const all = await db.select({ id: users.id, handle: users.handle }).from(users);
    expect(all).toHaveLength(1);
    expect(all[0]?.handle).toBe("alice-renamed");
  });

  test("provisioning NEVER re-enables a disabled user (preserves the admin disable)", async () => {
    const r = await provisionIdentity(db, { externalId: "ext-a", handle: "alice", groups: [] });
    await db.update(users).set({ enabled: false }).where(eq(users.id, r.id));
    const again = await provisionIdentity(db, {
      externalId: "ext-a",
      handle: "alice",
      groups: [],
    });
    expect(again.id).toBe(r.id);
    expect(again.enabled).toBe(false);
  });
});

describe("requireAdmin", () => {
  test("the owner/admin passes and gets their ownerId back", async () => {
    const expected = await ensureUser(db, env.DEFAULT_USER_HANDLE);
    await expect(requireAdmin(db, env.DEFAULT_USER_HANDLE)).resolves.toBe(expected);
  });

  test("a JIT-provisioned non-owner is rejected (FORBIDDEN), against a real app-produced state", async () => {
    await ensureUser(db, "intruder");
    await expect(requireAdmin(db, "intruder")).rejects.toBeInstanceOf(DomainForbiddenError);
  });
});
