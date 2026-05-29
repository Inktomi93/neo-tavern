import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db, runMigrations } from "../../../db/client";
import { sessions, users } from "../../../db/schema";
import { provisionIdentity } from "../_shared/users";
import { createSessionsService } from "./service";

let db: Db;
let svc: ReturnType<typeof createSessionsService>;
let userId: string;

beforeEach(async () => {
  db = await createDb(":memory:");
  await runMigrations(db);
  svc = createSessionsService(db);
  // Seed an SSO-shaped user (externalId set), like an OIDC login would.
  ({ id: userId } = await provisionIdentity(db, {
    externalId: "ext-alice",
    handle: "alice",
    groups: [],
  }));
});

describe("create + validate", () => {
  test("a freshly minted token validates to the owning identity", async () => {
    const { token } = await svc.create({ userId });
    expect(await svc.validate(token)).toEqual({
      externalId: "ext-alice",
      handle: "alice",
      groups: [],
    });
  });

  test("an unknown token is rejected", async () => {
    await svc.create({ userId });
    expect(await svc.validate("not-a-real-token")).toBeNull();
  });

  test("the plaintext token is never stored — only its hash", async () => {
    const { token } = await svc.create({ userId });
    const rows = await db.select({ tokenHash: sessions.tokenHash }).from(sessions);
    expect(rows[0]?.tokenHash).toBeDefined();
    expect(rows[0]?.tokenHash).not.toBe(token);
  });
});

describe("revocation (the §16 test-2 core: rejected on the NEXT request, not at expiry)", () => {
  test("revokeByToken (logout) rejects the same token immediately", async () => {
    const { token } = await svc.create({ userId });
    expect(await svc.validate(token)).not.toBeNull();
    await svc.revokeByToken(token);
    expect(await svc.validate(token)).toBeNull();
  });

  test("disabling the owning user rejects the token on the next validate", async () => {
    const { token } = await svc.create({ userId });
    await db.update(users).set({ enabled: false }).where(eq(users.id, userId));
    expect(await svc.validate(token)).toBeNull();
  });

  test("revoking device A's session leaves device B's working", async () => {
    const a = await svc.create({ userId, userAgent: "device-A" });
    const b = await svc.create({ userId, userAgent: "device-B" });
    await svc.revoke(a.sessionId);
    expect(await svc.validate(a.token)).toBeNull();
    expect(await svc.validate(b.token)).not.toBeNull();
  });

  test("revokeAllForUser kills every live session and reports the count", async () => {
    const a = await svc.create({ userId });
    const b = await svc.create({ userId });
    expect(await svc.revokeAllForUser(userId)).toBe(2);
    expect(await svc.validate(a.token)).toBeNull();
    expect(await svc.validate(b.token)).toBeNull();
    // Idempotent: nothing live left to revoke.
    expect(await svc.revokeAllForUser(userId)).toBe(0);
  });
});

describe("expiry + sliding", () => {
  test("an expired session is rejected", async () => {
    const { token, sessionId } = await svc.create({ userId });
    await db
      .update(sessions)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(sessions.id, sessionId));
    expect(await svc.validate(token)).toBeNull();
  });

  test("validate slides the window forward once lastSeenAt is stale", async () => {
    const { token, sessionId, expiresAt } = await svc.create({ userId });
    // Backdate lastSeenAt past the slide throttle so the next validate bumps the window.
    const staleLastSeen = Date.now() - 1000 * 60 * 60;
    await db.update(sessions).set({ lastSeenAt: staleLastSeen }).where(eq(sessions.id, sessionId));
    expect(await svc.validate(token)).not.toBeNull();
    const after = await db
      .select({ lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    // lastSeenAt jumping from an hour ago to ~now is the definitive proof the slide write fired;
    // expiresAt re-extends to now+TTL (≥ the original, which may be equal within the same ms).
    expect(after[0]?.lastSeenAt).toBeGreaterThan(staleLastSeen);
    expect(after[0]?.expiresAt).toBeGreaterThanOrEqual(expiresAt);
  });
});

describe("listForUser", () => {
  test("lists the user's sessions", async () => {
    await svc.create({ userId, userAgent: "phone" });
    await svc.create({ userId, userAgent: "desktop" });
    const list = await svc.listForUser(userId);
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.userAgent).sort()).toEqual(["desktop", "phone"]);
  });
});
