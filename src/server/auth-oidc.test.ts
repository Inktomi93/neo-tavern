import { describe, expect, test } from "vitest";
import { deriveRedirectUri, SESSION_COOKIE_NAME, sessionCookieOptions } from "./auth-oidc";

// The security-critical PURE logic of the OIDC routes (the network legs — discovery, code exchange —
// are exercised by the manual smoke test in docs/auth.md, per tests/AGENTS.md "mock only the provider
// boundary; don't build a brittle full-OIDC mock").

describe("deriveRedirectUri — origin-flexible, allowlist-validated (the open-redirect guard, §16)", () => {
  const allow = [
    "https://neo-tavern.inktomi.tech/api/auth/callback",
    "https://neo-tavern.lan/api/auth/callback",
  ];

  test("an allowlisted public-domain origin is accepted (derived from X-Forwarded-* behind the proxy)", () => {
    const headers = new Headers({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "neo-tavern.inktomi.tech",
    });
    expect(deriveRedirectUri(headers, allow)).toBe(
      "https://neo-tavern.inktomi.tech/api/auth/callback",
    );
  });

  test("an allowlisted LAN host ALSO works (domain AND LAN both log in)", () => {
    const headers = new Headers({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "neo-tavern.lan",
    });
    expect(deriveRedirectUri(headers, allow)).toBe("https://neo-tavern.lan/api/auth/callback");
  });

  test("an OFF-allowlist origin is REJECTED (no open redirect — the CVE-2024-52289 class)", () => {
    const headers = new Headers({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "evil.example.com",
    });
    expect(deriveRedirectUri(headers, allow)).toBeNull();
  });

  test("X-Forwarded-Proto is honored; falls back to the Host header when no forwarded host", () => {
    const headers = new Headers({
      "x-forwarded-proto": "https",
      host: "neo-tavern.inktomi.tech",
    });
    expect(deriveRedirectUri(headers, allow)).toBe(
      "https://neo-tavern.inktomi.tech/api/auth/callback",
    );
  });

  test("no host at all → null (nothing to derive)", () => {
    expect(deriveRedirectUri(new Headers(), allow)).toBeNull();
  });
});

describe("sessionCookieOptions — the locked §11 cookie contract", () => {
  test("HttpOnly + Secure + SameSite=Lax + Path / (never a JS-readable / plaintext-http cookie)", () => {
    const opts = sessionCookieOptions(3600);
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(true);
    expect(opts.sameSite).toBe("Lax");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(3600);
  });

  test("uses the __Host- name prefix + satisfies its requirements (Secure, Path /, no Domain)", () => {
    expect(SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    const opts = sessionCookieOptions(3600);
    expect(opts.secure).toBe(true); // __Host- requires Secure
    expect(opts.path).toBe("/"); // __Host- requires Path=/
    expect("domain" in opts).toBe(false); // __Host- forbids a Domain attribute
  });
});
