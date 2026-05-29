import process from "node:process";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { createDb } from "../src/db/client";
import { provisionIdentity } from "../src/server/domain/_shared/users";
import { createSessionsService } from "../src/server/domain/sessions";
import { env } from "../src/server/env";

// End-to-end auth verification probe (docs/auth-verify.md). Fires real HTTP at a RUNNING neo-tavern
// and asserts the auth behaviors for the server's AUTH_MODE — run it while tailing the server logs to
// WATCH the seam (identity resolution, session create/validate, JWT verify, gate refusals). It also
// has a read-only `--remote <url>` mode to smoke-test a live Caddy+authentik deployment.
//
// It shares the server's DB + SESSION_SECRET (same env) so it can MINT a session directly for the
// oidc cookie checks WITHOUT the full authentik browser dance (which the runbook covers separately).
// Use an ISOLATED throwaway DATABASE_URL for both server + probe so nothing touches your real corpus.

const args = process.argv.slice(2);
const remoteIdx = args.indexOf("--remote");
const REMOTE = remoteIdx !== -1 ? args[remoteIdx + 1] : undefined;
const BASE = REMOTE ?? process.env["VERIFY_BASE_URL"] ?? "http://localhost:8788";
const MODE = env.AUTH_MODE;
const FALLBACK = env.AUTH_FALLBACK;

let passed = 0;
let failed = 0;
function ok(name: string, detail = ""): void {
  passed++;
  console.info(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name: string, detail = ""): void {
  failed++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) ok(name, detail);
  else bad(name, detail);
}
function section(title: string): void {
  console.info(`\n── ${title} ──`);
}

// A no-input authed tRPC query — 200 ⇒ a resolved identity passed authedProcedure; 401 ⇒ no identity.
async function authedQuery(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}/api/trpc/settings.getUserSettings`, { method: "GET", headers });
}
// An authed tRPC MUTATION (for the CSRF gate). The CSRF middleware fires before input handling, so an
// empty body still surfaces the 403 when it should.
async function authedMutation(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}/api/trpc/settings.setGlobalSetting`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ key: "_verify_probe", value: Date.now() }),
  });
}

// Sign an authentik-shaped JWT + return the matching JWKS JSON — exactly what caddy+authentik forward
// (the app verifies the JWT against the forwarded JWKS, §1c). Lets the probe exercise the real verify
// path. (Hitting the app directly like this is the "don't expose 8788" boundary — fine for a probe.)
async function forwardHeaders(
  sub: string,
  handle: string,
  groups: string[] = [],
): Promise<Record<string, string>> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.alg = "RS256";
  jwk.kid = "verify-probe";
  const jwt = await new SignJWT({ preferred_username: handle, groups })
    .setProtectedHeader({ alg: "RS256", kid: "verify-probe" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return {
    "x-authentik-jwt": jwt,
    "x-authentik-meta-jwks": JSON.stringify({ keys: [jwk] }),
    "x-authentik-username": handle,
    "x-authentik-uid": sub,
  };
}

async function verifyHealth(): Promise<void> {
  section("Public surface");
  try {
    const res = await fetch(`${BASE}/api/healthz`);
    const body = (await res.json()) as { ok?: boolean; version?: string };
    check(
      "GET /api/healthz is public + 200",
      res.status === 200 && body.ok === true,
      `version ${body.version}`,
    );
  } catch (err) {
    bad("GET /api/healthz", err instanceof Error ? err.message : String(err));
  }
}

async function verifySingleUser(): Promise<void> {
  section("single-user (owner fallback, no headers, no session)");
  const res = await authedQuery();
  check(
    "an un-credentialed request resolves to the owner (authed query 200)",
    res.status === 200,
    `status ${res.status}`,
  );
  // Stray forward-auth headers must be IGNORED in single-user (a box behind some other proxy mustn't trust them).
  const spoof = await authedQuery({
    "x-authentik-username": "attacker",
    "x-authentik-uid": "evil",
  });
  check(
    "stray X-Authentik-* headers are ignored (still the owner, 200)",
    spoof.status === 200,
    `status ${spoof.status}`,
  );
}

async function verifyForwardHeader(): Promise<void> {
  section("forward-header (JWKS-verified X-Authentik-Jwt)");
  const good = await authedQuery(await forwardHeaders("ext-probe", "probe-user", ["Neo Owners"]));
  check(
    "a signed X-Authentik-Jwt resolves an identity (authed query 200)",
    good.status === 200,
    `status ${good.status}`,
  );

  const fh = await forwardHeaders("ext-probe", "probe-user");
  const tampered = await authedQuery({
    ...fh,
    "x-authentik-jwt": `${fh["x-authentik-jwt"]}tampered`,
  });
  if (FALLBACK === "deny") {
    check(
      "a tampered JWT is rejected (no fall-through) → 401",
      tampered.status === 401,
      `status ${tampered.status}`,
    );
  } else {
    check(
      "a tampered JWT falls through to the owner fallback → 200 (AUTH_FALLBACK=owner)",
      tampered.status === 200,
      `status ${tampered.status}`,
    );
  }
}

async function verifyOidc(): Promise<void> {
  section(
    "oidc (revocable cookie session + CSRF) — minting a session directly (no authentik needed)",
  );
  const db = await createDb(env.DATABASE_URL);
  const sessions = createSessionsService(db);
  const { id } = await provisionIdentity(db, {
    externalId: "ext-probe",
    handle: "verify-probe",
    groups: [],
  });
  const { token, sessionId } = await sessions.create({
    userId: id,
    userAgent: "verify-auth probe",
  });
  const cookie = `neo_session=${token}`;

  const authed = await authedQuery({ cookie });
  check(
    "a valid session cookie authenticates (authed query 200)",
    authed.status === 200,
    `status ${authed.status}`,
  );

  const noHeader = await authedMutation({ cookie });
  check(
    "CSRF: a cookie MUTATION without x-neo-csrf is rejected → 403",
    noHeader.status === 403,
    `status ${noHeader.status}`,
  );
  const withHeader = await authedMutation({ cookie, "x-neo-csrf": "1" });
  check(
    "CSRF: the same mutation WITH x-neo-csrf is NOT blocked",
    withHeader.status !== 403,
    `status ${withHeader.status}`,
  );

  await sessions.revokeByToken(token);
  const afterRevoke = await authedQuery({ cookie });
  check(
    "after revoke, the SAME cookie is rejected on the next request",
    afterRevoke.status === 401,
    `status ${afterRevoke.status}`,
  );

  // Cleanup the throwaway session row.
  await sessions.revoke(sessionId).catch(() => {});
}

async function verifyRemote(): Promise<void> {
  section(`remote live deployment: ${BASE}`);
  const health = await fetch(`${BASE}/api/healthz`);
  check("healthz reachable + 200", health.status === 200, `status ${health.status}`);
  const me = await fetch(`${BASE}/api/auth/me`);
  if (me.status === 200) {
    const body = (await me.json()) as { authenticated?: boolean };
    check(
      "/api/auth/me responds (no cookie → not authenticated)",
      body.authenticated === false,
      JSON.stringify(body),
    );
  } else {
    bad("/api/auth/me", `status ${me.status} (is AUTH_MODE=oidc on the deployment?)`);
  }
  // Login should 302 to authentik (we don't follow it).
  const login = await fetch(`${BASE}/api/auth/login`, { redirect: "manual" });
  const loc = login.headers.get("location") ?? "";
  check(
    "/api/auth/login → 302 to the IdP",
    login.status >= 300 && login.status < 400,
    `→ ${loc.slice(0, 60)}…`,
  );
}

async function main(): Promise<void> {
  console.info(
    `\nneo-tavern auth verification — ${REMOTE ? "REMOTE" : `local AUTH_MODE=${MODE}, AUTH_FALLBACK=${FALLBACK}`}`,
  );
  console.info(`target: ${BASE}\n`);

  if (REMOTE) {
    await verifyRemote();
  } else {
    await verifyHealth();
    if (MODE === "single-user") await verifySingleUser();
    else if (MODE === "forward-header") await verifyForwardHeader();
    else if (MODE === "oidc") await verifyOidc();
  }

  console.info(
    `\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILURES"} — ${passed} passed, ${failed} failed\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-auth crashed:", err instanceof Error ? err.stack : err);
  process.exit(2);
});
