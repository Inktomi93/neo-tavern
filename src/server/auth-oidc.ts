import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import * as client from "openid-client";
import type { Db } from "../db/client";
import { clearSessionCookie, sessionCookieOptions, setSessionCookie } from "./auth/cookie";
import { SESSION_COOKIE_NAME } from "./auth/trust-header";
import { provisionIdentity } from "./domain/_shared/users";
import type { SessionsService } from "./domain/sessions";
import { env } from "./env";
import { getLog } from "./observability/logger";

// OIDC server routes (docs/auth/auth-and-credentials-plan.md §10) — the app as a confidential authentik
// OIDC client (BFF). Origin-flexible: redirect_uri is DERIVED from the request origin + validated
// against an allowlist (so login works via the domain OR a LAN HTTPS host), NEVER reflected blindly
// (the open-redirect / CVE-2024-52289 class). The session rides in an HttpOnly/Secure/SameSite=Lax
// cookie; NO token in any URL/fragment. openid-client v6 (its API differs substantially from v5).

// SESSION_COOKIE_NAME (the `__Host-`-prefixed name) is owned by auth/trust-header (the raw
// resolveIdentity parser uses it too); re-exported here for the OIDC routes + tests.
// The session-cookie write helpers + the §11 contract now live in auth/cookie.ts (shared with the
// local-auth routes). Re-exported here so existing importers (auth-oidc.test.ts) are unaffected.
export { SESSION_COOKIE_NAME, sessionCookieOptions };

/** The comma-list allowlist of permitted callback origins' full URLs (env.OIDC_REDIRECT_URIS). */
function redirectAllowlist(): string[] {
  return (env.OIDC_REDIRECT_URIS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

/**
 * Derive the callback redirect_uri from the request origin (X-Forwarded-Proto + Host) and accept it
 * ONLY if it's in the allowlist — the open-redirect guard. Returns null for an off-allowlist origin.
 * Pure (no network) so it's unit-tested directly (§16 origin-flexible test).
 */
export function deriveRedirectUri(headers: Headers, allowlist: string[]): string | null {
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host");
  if (!host) return null;
  const candidate = `${proto}://${host}/api/auth/callback`;
  return allowlist.includes(candidate) ? candidate : null;
}

interface OidcTransaction {
  verifier: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number;
}

const TX_TTL_MS = 1000 * 60 * 10; // a login attempt must complete within 10 minutes

/**
 * Narrow the three OIDC env vars to `string`. The env refinement already guarantees they're present
 * in `oidc` mode, but that invariant lives in the schema, not the type — so assert it once at the
 * discovery seam (instead of three `as string` casts) and fail loud if the invariant ever breaks.
 */
function assertOidcEnv(): { issuer: string; clientId: string; clientSecret: string } {
  const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = env;
  if (
    OIDC_ISSUER === undefined ||
    OIDC_CLIENT_ID === undefined ||
    OIDC_CLIENT_SECRET === undefined
  ) {
    throw new Error("OIDC env (issuer/client id/secret) missing in oidc mode");
  }
  return { issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: OIDC_CLIENT_SECRET };
}

/**
 * Register the OIDC routes — only in `oidc` mode (the env refinement guarantees the OIDC vars are
 * present then). Registered in buildApp like registerImportRoutes; all four paths are public (Hono
 * routes, not behind the tRPC 401 gate). Single-process assumption: the in-flight transaction state
 * (PKCE verifier / nonce / origin) is held in memory keyed by `state`, NEVER in a cookie (so SameSite
 * can't interfere with the callback) — exactly the §4 design.
 */
export function registerOidcRoutes(app: Hono, db: Db, sessions: SessionsService): void {
  if (env.AUTH_MODE !== "oidc") return;

  // Discovery is cached (one Configuration per process); the promise is memoized so concurrent first
  // requests share one discovery round-trip.
  let configPromise: Promise<client.Configuration> | undefined;
  const getConfig = (): Promise<client.Configuration> => {
    if (!configPromise) {
      const { issuer, clientId, clientSecret } = assertOidcEnv();
      configPromise = client.discovery(new URL(issuer), clientId, clientSecret);
    }
    return configPromise;
  };

  const transactions = new Map<string, OidcTransaction>();

  app.get("/api/auth/login", async (c) => {
    const redirectUri = deriveRedirectUri(c.req.raw.headers, redirectAllowlist());
    if (!redirectUri) {
      return c.json({ error: "This origin is not an allowed OIDC callback." }, 400);
    }
    const config = await getConfig();
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    transactions.set(state, { verifier, nonce, redirectUri, expiresAt: Date.now() + TX_TTL_MS });
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid profile email",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return c.redirect(url.href);
  });

  app.get("/api/auth/callback", async (c) => {
    const incoming = new URL(c.req.url);
    const state = incoming.searchParams.get("state");
    const tx = state ? transactions.get(state) : undefined;
    if (!state || !tx) {
      return c.json({ error: "Invalid or unknown OIDC state." }, 400);
    }
    transactions.delete(state);
    if (tx.expiresAt < Date.now()) {
      return c.json({ error: "OIDC login expired; try again." }, 400);
    }

    // Reconstruct the callback URL as the PUBLIC origin (the validated redirect_uri) + the incoming
    // query, so the token exchange uses the SAME redirect_uri authentik saw — robust behind the proxy
    // (where c.req.url's host is the internal upstream).
    const callbackUrl = new URL(tx.redirectUri);
    callbackUrl.search = incoming.search;

    let tokens: client.TokenEndpointResponse & { claims(): client.IDToken | undefined };
    try {
      const config = await getConfig();
      tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: tx.verifier,
        expectedState: state,
        expectedNonce: tx.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      getLog().warn(
        { err: err instanceof Error ? err.message : String(err) },
        "auth: OIDC code exchange failed",
      );
      return c.json({ error: "OIDC authentication failed." }, 401);
    }

    const claims = tokens.claims();
    if (!claims?.sub) {
      return c.json({ error: "OIDC token had no subject." }, 401);
    }
    // authentik claim names are OIDC wire fields on the IDToken index signature → bracket access.
    const rawGroups = claims["groups"];
    const groups = Array.isArray(rawGroups)
      ? rawGroups.filter((g): g is string => typeof g === "string")
      : [];
    const preferredUsername = claims["preferred_username"];
    const handle = typeof preferredUsername === "string" ? preferredUsername : String(claims.sub);
    const { id, enabled } = await provisionIdentity(db, {
      externalId: String(claims.sub),
      handle,
      groups,
    });
    if (!enabled) {
      return c.json({ error: "This account is disabled." }, 403);
    }

    const { token, expiresAt } = await sessions.create({
      userId: id,
      userAgent: c.req.header("user-agent") ?? null,
    });
    // The BFF win: the session token rides in the cookie, NEVER the URL/fragment.
    setSessionCookie(c, token, expiresAt);
    getLog().info({ handle, userId: id }, "auth: OIDC login");
    // 302 back to the app root on the originating origin (no token in the redirect).
    return c.redirect(`${new URL(tx.redirectUri).origin}/`);
  });

  app.post("/api/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (token) {
      await sessions.revokeByToken(token);
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", async (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    const identity = token ? await sessions.validate(token) : null;
    return c.json({ authenticated: identity !== null, handle: identity?.handle ?? null });
  });
}
