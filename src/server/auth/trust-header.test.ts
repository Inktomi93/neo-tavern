import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { describe, expect, test } from "vitest";
import { type AuthConfig, isLocalOrigin, resolveIdentity } from "./trust-header";

// Config builders so each test states exactly which mode/fallback it exercises (resolveIdentity takes
// config explicitly precisely so these don't depend on the once-parsed env).
const cfg = (over: Partial<AuthConfig>): AuthConfig => ({
  mode: "single-user",
  fallback: "owner",
  defaultHandle: "owner",
  verifyForwardJwt: true,
  trustedLocalHosts: [],
  ...over,
});

// A request targeting the public FQDN (the domain/SSO path) vs the raw LAN IP (the owner path).
const PUBLIC_ORIGIN = { host: "neo-tavern.inktomi.tech" };
const LAN_ORIGIN = { host: "192.168.1.50:8788" };

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

  test("Authelia Remote-* trusted headers resolve an identity (no uid → externalId null)", async () => {
    const headers = new Headers({
      "remote-user": "dana",
      "remote-groups": "admins, editors",
    });
    const { identity } = await resolveIdentity(
      headers,
      cfg({ mode: "forward-header", verifyForwardJwt: false }),
    );
    expect(identity).toEqual({ externalId: null, handle: "dana", groups: ["admins", "editors"] });
  });

  test("a custom user/groups header overrides the known families", async () => {
    const headers = new Headers({ "x-proxy-user": "erin", "x-proxy-groups": "g1|g2" });
    const { identity } = await resolveIdentity(
      headers,
      cfg({
        mode: "forward-header",
        verifyForwardJwt: false,
        forwardUserHeader: "x-proxy-user",
        forwardGroupsHeader: "x-proxy-groups",
      }),
    );
    expect(identity).toEqual({ externalId: null, handle: "erin", groups: ["g1", "g2"] });
  });

  test("opt-in trusted-proxy gate: rejects an unsigned identity from an untrusted source IP", async () => {
    const headers = new Headers({ "remote-user": "dana", "x-forwarded-for": "203.0.113.9" });
    const { identity } = await resolveIdentity(
      headers,
      cfg({
        mode: "forward-header",
        verifyForwardJwt: false,
        forwardTrustedProxies: ["10.0.0.0/8"],
      }),
    );
    expect(identity).toBeNull();
  });

  test("opt-in trusted-proxy gate: accepts an unsigned identity from a trusted source IP", async () => {
    const headers = new Headers({ "remote-user": "dana", "x-forwarded-for": "10.1.2.3" });
    const { identity } = await resolveIdentity(
      headers,
      cfg({
        mode: "forward-header",
        verifyForwardJwt: false,
        forwardTrustedProxies: ["10.0.0.0/8"],
      }),
    );
    expect(identity?.handle).toBe("dana");
  });
});

describe("resolveIdentity — oidc cookie", () => {
  test("reads __Host-neo_session, validates it via the injected validator, and reports viaCookie", async () => {
    const headers = new Headers({ cookie: "__Host-neo_session=opaque-token; other=x" });
    const { identity, viaCookie } = await resolveIdentity(headers, cfg({ mode: "oidc" }), {
      validateSessionCookie: async (token) =>
        token === "opaque-token" ? { externalId: "ext-c", handle: "carol", groups: [] } : null,
    });
    expect(identity).toEqual({ externalId: "ext-c", handle: "carol", groups: [] });
    expect(viaCookie).toBe(true);
  });

  test("an unrecognized cookie on a LOCAL origin falls through to the owner fallback (not viaCookie)", async () => {
    // Stale cookie on the raw-LAN path → the owner fallback still applies (origin is local).
    const headers = new Headers({ cookie: "__Host-neo_session=stale", ...LAN_ORIGIN });
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

// ── The bypass regression (docs/auth/auth-and-credentials-plan.md §2) ─────────────────────────────────
// In an SSO mode the `owner` fallback is the raw-LAN convenience path ONLY. The exact hole this guards:
// an un-cookied request to the PUBLIC FQDN under `oidc`+`owner` must NOT resolve to the owner (which
// the seam would promote to admin) — it must resolve to null → 401 → SSO mandatory.
describe("resolveIdentity — origin-gated owner fallback (SSO modes)", () => {
  test("oidc + owner: a no-cookie PUBLIC-origin request resolves to null (NOT the owner)", async () => {
    const headers = new Headers({ ...PUBLIC_ORIGIN }); // no cookie, public domain
    const { identity, viaFallback } = await resolveIdentity(headers, cfg({ mode: "oidc" }), {
      validateSessionCookie: async () => null,
    });
    expect(identity).toBeNull();
    expect(viaFallback).toBe(false);
  });

  test("oidc + owner: a no-cookie LOCAL-origin (raw LAN IP) request resolves to the owner", async () => {
    const headers = new Headers({ ...LAN_ORIGIN });
    const { identity, viaFallback } = await resolveIdentity(headers, cfg({ mode: "oidc" }), {
      validateSessionCookie: async () => null,
    });
    expect(identity).toEqual({ externalId: null, handle: "owner", groups: [] });
    expect(viaFallback).toBe(true);
  });

  test("forward-header + owner: a no-credential PUBLIC-origin request resolves to null", async () => {
    const headers = new Headers({ ...PUBLIC_ORIGIN });
    const { identity } = await resolveIdentity(
      headers,
      cfg({ mode: "forward-header", verifyForwardJwt: false }),
    );
    expect(identity).toBeNull();
  });

  test("a TRUSTED_LOCAL_HOSTS hostname is treated as a local origin", async () => {
    const headers = new Headers({ host: "neo.lan" });
    const { identity } = await resolveIdentity(
      headers,
      cfg({ mode: "oidc", trustedLocalHosts: ["neo.lan"] }),
      { validateSessionCookie: async () => null },
    );
    expect(identity?.handle).toBe("owner");
  });

  test("single-user owner fallback is UNCONDITIONAL (origin-independent — the zero-infra contract)", async () => {
    // Even a public-origin request gets the owner in single-user mode (no SSO exists to fall back to).
    const { identity } = await resolveIdentity(
      new Headers({ ...PUBLIC_ORIGIN }),
      cfg({ mode: "single-user" }),
    );
    expect(identity?.handle).toBe("owner");
  });
});

// ── local-password mode (AUTH_MODE=local) ────────────────────────────────────────────────────────
// `local` rides the SAME cookie layer as oidc (a session minted by password login) and the SAME
// origin-gated owner fallback (LAN owner convenience, public host must log in).
describe("resolveIdentity — local mode", () => {
  test("a valid session cookie resolves to the cookie identity (viaCookie)", async () => {
    const headers = new Headers({ ...PUBLIC_ORIGIN, cookie: "__Host-neo_session=tok" });
    const { identity, viaCookie } = await resolveIdentity(headers, cfg({ mode: "local" }), {
      validateSessionCookie: async (t) =>
        t === "tok" ? { externalId: null, handle: "alice", groups: [] } : null,
    });
    expect(identity?.handle).toBe("alice");
    expect(viaCookie).toBe(true);
  });

  test("no cookie on the PUBLIC origin resolves to null (must log in — NOT the owner)", async () => {
    const headers = new Headers({ ...PUBLIC_ORIGIN });
    const { identity, viaFallback } = await resolveIdentity(headers, cfg({ mode: "local" }), {
      validateSessionCookie: async () => null,
    });
    expect(identity).toBeNull();
    expect(viaFallback).toBe(false);
  });

  test("no cookie on the LAN origin resolves to the owner fallback (convenience)", async () => {
    const headers = new Headers({ ...LAN_ORIGIN });
    const { identity, viaFallback } = await resolveIdentity(headers, cfg({ mode: "local" }), {
      validateSessionCookie: async () => null,
    });
    expect(identity?.handle).toBe("owner");
    expect(viaFallback).toBe(true);
  });
});

describe("isLocalOrigin", () => {
  const localHosts = [
    "127.0.0.1",
    "127.0.0.1:8788",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.50:8788",
    "100.100.50.50", // Tailscale CGNAT 100.64.0.0/10
    "169.254.10.1",
    "localhost",
    "localhost:5173",
    "[::1]:8788",
    "[fd00::1]",
    "[fe80::1]",
  ];
  const publicHosts = [
    "neo-tavern.inktomi.tech",
    "8.8.8.8",
    "100.200.0.1", // outside Tailscale CGNAT 100.64.0.0/10 (public)
    "172.32.0.1", // just outside 172.16/12
    "172.15.0.1", // just below 172.16/12
    "example.com:443",
    "[2606:4700::1111]", // public IPv6
    "fd00.example.com", // hostname that PREFIX-matches ULA fd00::/7 but is NOT an IPv6 literal
    "fc-corp.internal", // hostname that PREFIX-matches fc00::/7
    "fe80-host.example.net", // hostname that PREFIX-matches link-local fe80::/10
  ];

  for (const host of localHosts) {
    test(`local: ${host}`, () => {
      expect(isLocalOrigin(new Headers({ host }), [])).toBe(true);
    });
  }
  for (const host of publicHosts) {
    test(`public: ${host}`, () => {
      expect(isLocalOrigin(new Headers({ host }), [])).toBe(false);
    });
  }
  test("a missing Host header is NOT local (fails closed)", () => {
    expect(isLocalOrigin(new Headers(), [])).toBe(false);
  });
  test("an explicit trusted host (case-insensitive) is local", () => {
    expect(isLocalOrigin(new Headers({ host: "Neo.LAN" }), ["neo.lan"])).toBe(true);
  });
  test("an extra CIDR range (TRUSTED_PRIVATE_RANGES) widens the trusted set", () => {
    // 203.0.113.0/24 is public by default → not local, unless added as an extra range.
    expect(isLocalOrigin(new Headers({ host: "203.0.113.7" }), [])).toBe(false);
    expect(isLocalOrigin(new Headers({ host: "203.0.113.7" }), [], ["203.0.113.0/24"])).toBe(true);
  });
});
