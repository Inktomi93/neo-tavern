import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { describe, expect, test } from "vitest";
import { type AuthConfig, resolveIdentity, resolveUsername } from "./trust-header";

// Config builders so each test states exactly which mode/fallback it exercises (resolveIdentity takes
// config explicitly precisely so these don't depend on the once-parsed env).
const cfg = (over: Partial<AuthConfig>): AuthConfig => ({
  mode: "single-user",
  fallback: "owner",
  defaultHandle: "owner",
  verifyForwardJwt: true,
  ...over,
});

// Sign a real authentik-shaped JWT + return the matching JWKS JSON, so the forward-header verify path
// is exercised cryptographically (not mocked) — the whole point of §1c.
async function signedAuthentikJwt(claims: {
  sub: string;
  preferred_username: string;
  groups?: string[];
}): Promise<{ jwt: string; jwksJson: string }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.alg = "RS256";
  jwk.kid = "test-key";
  const jwt = await new SignJWT({
    preferred_username: claims.preferred_username,
    ...(claims.groups ? { groups: claims.groups } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { jwt, jwksJson: JSON.stringify({ keys: [jwk] }) };
}

describe("resolveIdentity — single-user", () => {
  test("ignores forwarded headers entirely and returns the owner fallback", async () => {
    const headers = new Headers({
      "x-authentik-username": "attacker",
      "x-authentik-uid": "ext-attacker",
    });
    const { identity, viaCookie } = await resolveIdentity(headers, cfg({ mode: "single-user" }));
    expect(identity).toEqual({ externalId: null, handle: "owner", groups: [] });
    expect(viaCookie).toBe(false);
  });
});

describe("resolveIdentity — forward-header", () => {
  test("verifies X-Authentik-Jwt against the forwarded JWKS and trusts the claims", async () => {
    const { jwt, jwksJson } = await signedAuthentikJwt({
      sub: "ext-alice",
      preferred_username: "alice",
      groups: ["Neo Owners"],
    });
    const headers = new Headers({
      "x-authentik-jwt": jwt,
      "x-authentik-meta-jwks": jwksJson,
      // a lying plaintext header must NOT win over the verified JWT claims
      "x-authentik-username": "attacker",
    });
    const { identity, viaCookie } = await resolveIdentity(
      headers,
      cfg({ mode: "forward-header", fallback: "deny", verifyForwardJwt: true }),
    );
    expect(identity).toEqual({
      externalId: "ext-alice",
      handle: "alice",
      groups: ["Neo Owners"],
    });
    expect(viaCookie).toBe(false);
  });

  test("an invalid/tampered JWT is rejected (no fall-through to the unverified header)", async () => {
    const { jwt, jwksJson } = await signedAuthentikJwt({
      sub: "ext-alice",
      preferred_username: "alice",
    });
    const headers = new Headers({
      "x-authentik-jwt": `${jwt}tampered`,
      "x-authentik-meta-jwks": jwksJson,
      "x-authentik-username": "attacker",
    });
    const { identity } = await resolveIdentity(
      headers,
      cfg({ mode: "forward-header", fallback: "deny", verifyForwardJwt: true }),
    );
    expect(identity).toBeNull();
  });

  test("network-isolation trust (verify off) reads the raw X-Authentik-* headers", async () => {
    const headers = new Headers({
      "x-authentik-username": "bob",
      "x-authentik-uid": "ext-bob",
      "x-authentik-groups": "Team A|Team B",
    });
    const { identity } = await resolveIdentity(
      headers,
      cfg({ mode: "forward-header", verifyForwardJwt: false }),
    );
    expect(identity).toEqual({
      externalId: "ext-bob",
      handle: "bob",
      groups: ["Team A", "Team B"],
    });
  });
});

describe("resolveIdentity — oidc cookie", () => {
  test("reads neo_session, validates it via the injected validator, and reports viaCookie", async () => {
    const headers = new Headers({ cookie: "neo_session=opaque-token; other=x" });
    const { identity, viaCookie } = await resolveIdentity(headers, cfg({ mode: "oidc" }), {
      validateSessionCookie: async (token) =>
        token === "opaque-token" ? { externalId: "ext-c", handle: "carol", groups: [] } : null,
    });
    expect(identity).toEqual({ externalId: "ext-c", handle: "carol", groups: [] });
    expect(viaCookie).toBe(true);
  });

  test("an unrecognized cookie falls through to the fallback (not viaCookie)", async () => {
    const headers = new Headers({ cookie: "neo_session=stale" });
    const { identity, viaCookie } = await resolveIdentity(
      headers,
      cfg({ mode: "oidc", fallback: "owner" }),
      { validateSessionCookie: async () => null },
    );
    expect(identity).toEqual({ externalId: null, handle: "owner", groups: [] });
    expect(viaCookie).toBe(false);
  });
});

describe("resolveIdentity — fallback", () => {
  test("AUTH_FALLBACK=owner yields the owner when there's no credential", async () => {
    const { identity } = await resolveIdentity(new Headers(), cfg({ fallback: "owner" }));
    expect(identity?.handle).toBe("owner");
  });

  test("AUTH_FALLBACK=deny yields no identity (→ 401 at the caller)", async () => {
    const { identity } = await resolveIdentity(
      new Headers(),
      cfg({ mode: "forward-header", fallback: "deny" }),
    );
    expect(identity).toBeNull();
  });
});

describe("resolveUsername wrapper", () => {
  test("returns just the handle (the back-compat string contract, now async)", async () => {
    // single-user default env → owner fallback regardless of headers.
    const handle = await resolveUsername(new Headers({ "x-authentik-username": "ignored" }));
    expect(typeof handle).toBe("string");
    expect(handle.length).toBeGreaterThan(0);
  });
});
