import { expect } from "vitest";
import { ANONYMOUS_AUTH, authFor, callerFor, test } from "../support/fixtures";

// The tRPC procedure ladder (docs/auth/auth-and-credentials-plan.md §3) exercised through the REAL router
// + middleware — each gate proven to fire AND to be correctly scoped (not blanket). The callers state
// the auth they act under explicitly (no synthesized identity), so these aren't vacuous passes.

test("authedProcedure: no resolved identity → UNAUTHORIZED", async ({ services }) => {
  const anon = callerFor(services, ANONYMOUS_AUTH);
  await expect(anon.settings.getUserSettings()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("authedProcedure: a resolved identity passes", async ({ services }) => {
  const user = callerFor(services, authFor("alice", { role: "user" }));
  await expect(user.settings.getUserSettings()).resolves.toBeDefined();
});

test("adminProcedure: a non-admin is FORBIDDEN; an admin passes", async ({
  otherCaller,
  ownerCaller,
}) => {
  await expect(otherCaller.userAdmin.listUsers()).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(ownerCaller.userAdmin.listUsers()).resolves.toBeInstanceOf(Array);
});

test("CSRF: a cookie-authenticated mutation WITHOUT the custom header is FORBIDDEN", async ({
  services,
}) => {
  const cookieNoHeader = callerFor(
    services,
    authFor("alice", { role: "user", viaCookie: true, hasCsrfHeader: false }),
  );
  await expect(
    cookieNoHeader.settings.setGlobalSetting({ key: "x", value: "y" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("CSRF: a cookie-authenticated mutation WITH the custom header succeeds", async ({
  services,
}) => {
  const cookieWithHeader = callerFor(
    services,
    authFor("alice", { role: "user", viaCookie: true, hasCsrfHeader: true }),
  );
  await expect(
    cookieWithHeader.settings.setGlobalSetting({ key: "x", value: "y" }),
  ).resolves.toMatchObject({ value: "y" });
});

test("CSRF is scoped: a NON-cookie (header/fallback) mutation needs no custom header", async ({
  services,
}) => {
  // The raw-LAN-IP / forward-header path has no cross-site surface → the CSRF gate must not apply.
  const noCookie = callerFor(
    services,
    authFor("alice", { role: "user", viaCookie: false, hasCsrfHeader: false }),
  );
  await expect(noCookie.settings.setGlobalSetting({ key: "x", value: "y" })).resolves.toMatchObject(
    { value: "y" },
  );
});

test("CSRF is scoped: a cookie QUERY (not a mutation) needs no custom header", async ({
  services,
}) => {
  // The custom-header requirement is mutation-only — queries + subscriptions (incl. live push) are
  // exempt, so a cookie-authenticated read (and the SSE stream) works without it.
  const cookieQuery = callerFor(
    services,
    authFor("alice", { role: "user", viaCookie: true, hasCsrfHeader: false }),
  );
  await expect(cookieQuery.settings.getUserSettings()).resolves.toBeDefined();
});
