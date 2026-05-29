import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db, runMigrations } from "../../../db/client";
import { users } from "../../../db/schema";
import { env } from "../../env";
import { requireAdmin } from "./admin";
import { DomainForbiddenError } from "./errors";
import { ensureUser } from "./users";

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
