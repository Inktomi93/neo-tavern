import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db, runMigrations } from "../../../db/client";
import { createSecretBox } from "../../crypto/secrets";
import { env } from "../../env";
import { resolveCredential, storeUserKey } from "./credentials";
import { DomainForbiddenError } from "./errors";
import { provisionIdentity } from "./users";

let db: Db;
const box = createSecretBox(randomBytes(32)); // an enabled box with a known test key

beforeEach(async () => {
  db = await createDb(":memory:");
  await runMigrations(db);
});

// §16 test 1 — the resolver IS the access gate: max-pro-sub is owner/admin-only, and a BYO OpenRouter
// key is used over the host key. These are hermetic (the BYO assertions don't depend on a host key).
describe("resolveCredential — the turn-time access chokepoint", () => {
  test("an admin (the owner) may use max-pro-sub", async () => {
    const { id } = await provisionIdentity(db, {
      externalId: "owner-ext",
      handle: env.DEFAULT_USER_HANDLE,
      groups: [],
    });
    expect(await resolveCredential(db, box, id, "max-pro-sub")).toEqual({ source: "max-pro-sub" });
  });

  test("a non-admin is REFUSED max-pro-sub (DomainForbiddenError)", async () => {
    const { id } = await provisionIdentity(db, {
      externalId: "u-ext",
      handle: "alice",
      groups: [],
    });
    await expect(resolveCredential(db, box, id, "max-pro-sub")).rejects.toBeInstanceOf(
      DomainForbiddenError,
    );
  });

  test("openrouter uses the user's OWN (BYO) key — not the host key", async () => {
    const { id } = await provisionIdentity(db, {
      externalId: "u-ext",
      handle: "alice",
      groups: [],
    });
    await storeUserKey(db, box, id, "openrouter", "sk-or-USER-byok");
    const cred = await resolveCredential(db, box, id, "openrouter");
    expect(cred).toEqual({ source: "openrouter", openRouterKey: "sk-or-USER-byok" });
    // Proves the per-user key wins over any host OPENROUTER_API_KEY.
    if (cred.source === "openrouter") {
      expect(cred.openRouterKey).not.toBe(env.OPENROUTER_API_KEY);
    }
  });
});
