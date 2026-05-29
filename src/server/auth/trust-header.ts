// The auth seam — LAYERED identity resolution (docs/auth-and-credentials-plan.md §2).
//
// The app only CONSUMES identity, never an IdP. `AUTH_MODE` picks the SSO mechanism and
// `AUTH_FALLBACK` decides the un-credentialed case; the layers are tried in order PER REQUEST:
//   1. session cookie     (oidc)            → an opaque token validated against the `sessions` table
//   2. forward-auth header (forward-header) → X-Authentik-* trusted by verifying X-Authentik-Jwt (JWKS)
//   3. fallback                              → owner (DEFAULT_USER_HANDLE) or deny (null → 401)
// so `oidc` + `owner` = SSO on the domain AND owner on the raw LAN IP, from one process.
//
// LAYER RULE (docs/architecture.md): `auth` is infrastructure — it must NOT import `domain`. The two
// db-dependent pieces (the session lookup; the user upsert) are therefore INJECTED by the composition
// root, keeping this module db-free + unit-testable. `provisionIdentity` (the upsert) lives in
// domain/_shared/users.ts; the cookie validator comes from the sessions domain service.
import { createLocalJWKSet, createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { ResolvedIdentity } from "../../shared/identity";
import { env } from "../env";
import { getLog } from "../observability/logger";

/** The bits of config the resolver needs, passed explicitly so unit tests can vary mode/fallback
 *  without re-parsing env. `authConfigFromEnv()` builds the live one. */
export interface AuthConfig {
  mode: "single-user" | "forward-header" | "oidc";
  fallback: "owner" | "deny";
  defaultHandle: string;
  verifyForwardJwt: boolean;
}

/** Injected, db-dependent resolution steps (wired at the composition root; absent ⇒ that layer is
 *  inert). Keeps this infra module from importing the domain/db layers it sits below. */
export interface ResolveDeps {
  /** Validate a `neo_session` cookie token → identity, or null if missing/revoked/expired/disabled.
   *  Backed by the sessions domain service (which enforces users.enabled every request). oidc only. */
  validateSessionCookie?: (token: string) => Promise<ResolvedIdentity | null>;
}

/** What the resolver returns: the identity (or null when denied) + how it was resolved.
 *  - `viaCookie` is the per-request CSRF signal (a cookie request has a cross-site surface; a
 *    header/fallback request does not).
 *  - `viaFallback` marks the un-credentialed owner-fallback path — the SAFE discriminator for "this
 *    IS the owner" (a forward-header identity may also have externalId === null when no uid header was
 *    forwarded, so externalId-null alone must NOT be read as "owner"). The seam role-resolves the
 *    non-fallback (SSO) identities; the fallback is the owner/admin without a DB touch. */
export interface IdentityResolution {
  identity: ResolvedIdentity | null;
  viaCookie: boolean;
  viaFallback: boolean;
}

const SESSION_COOKIE = "neo_session";
const CSRF_HEADER = "x-neo-csrf";

export function authConfigFromEnv(): AuthConfig {
  return {
    mode: env.AUTH_MODE,
    fallback: env.AUTH_FALLBACK,
    defaultHandle: env.DEFAULT_USER_HANDLE,
    verifyForwardJwt: env.FORWARD_AUTH_VERIFY_JWT,
  };
}

/** True when the request carries the custom CSRF header (any value). `SameSite=Lax` + this header is
 *  the whole CSRF story (§4); a cross-site page can't set a custom header without a CORS preflight we
 *  don't grant. Read at the seam, carried into the tRPC context. */
export function hasCsrfHeader(headers: Headers): boolean {
  return headers.get(CSRF_HEADER) !== null;
}

// Minimal cookie parse — we only ever read our own opaque session token. Avoids a cookie-lib dep at
// the resolver (Hono's getCookie is used on the write/route side where a Context is in hand).
function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// X-Authentik-Meta-Jwks is forwarded alongside the JWT; it is either the JWKS JSON itself or a URL to
// it. Build a jose key-set from whichever shape arrived. Memoized per distinct value (the keys rotate
// rarely; a remote set caches+refreshes internally).
const jwksCache = new Map<
  string,
  ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet>
>();
function jwksFor(metaJwks: string) {
  const cached = jwksCache.get(metaJwks);
  if (cached) return cached;
  const trimmed = metaJwks.trim();
  const set = trimmed.startsWith("{")
    ? createLocalJWKSet(JSON.parse(trimmed))
    : createRemoteJWKSet(new URL(trimmed));
  jwksCache.set(metaJwks, set);
  return set;
}

function groupsFromClaim(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.filter((g): g is string => typeof g === "string");
  // Network-trust header form: authentik joins groups with "|"; tolerate commas too.
  if (typeof claim === "string" && claim.length > 0) {
    return claim
      .split(/[|,]/)
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
  }
  return [];
}

// forward-header layer. When FORWARD_AUTH_VERIFY_JWT is on AND authentik forwarded a signed JWT (+ the
// JWKS to verify it), trust the CLAIMS — cryptographic, spoof-proof regardless of network path (§1c).
// Otherwise fall back to network-isolation trust of the raw X-Authentik-* headers (every other app in
// the stack relies on this). Returns null when no usable identity is present.
async function resolveForwardHeader(
  headers: Headers,
  verifyJwt: boolean,
): Promise<ResolvedIdentity | null> {
  const jwt = headers.get("x-authentik-jwt");
  const metaJwks = headers.get("x-authentik-meta-jwks");
  if (verifyJwt && jwt && metaJwks) {
    try {
      const { payload } = await jwtVerify(jwt, jwksFor(metaJwks));
      const claims = payload as JWTPayload & {
        preferred_username?: unknown;
        groups?: unknown;
      };
      const handle =
        typeof claims.preferred_username === "string" ? claims.preferred_username : undefined;
      const externalId = typeof claims.sub === "string" ? claims.sub : null;
      if (handle) {
        return { externalId, handle, groups: groupsFromClaim(claims.groups) };
      }
    } catch (err) {
      // A present-but-invalid JWT is a spoof attempt or a misconfig — do NOT silently fall through to
      // the unverified header path (that would defeat the point). Treat as no identity.
      getLog().warn(
        { err: err instanceof Error ? err.message : String(err) },
        "auth: X-Authentik-Jwt verification failed — rejecting forwarded identity",
      );
      return null;
    }
  }
  // Network-isolation trust (verify off, or no JWT forwarded): the raw headers.
  const handle = headers.get("x-authentik-username");
  if (!handle) return null;
  return {
    externalId: headers.get("x-authentik-uid"),
    handle,
    groups: groupsFromClaim(headers.get("x-authentik-groups")),
  };
}

/**
 * Resolve the caller identity by the layered policy. `single-user` ignores headers entirely (a box
 * behind some other proxy must not trust stray X-Authentik headers or cookies). Returns the identity
 * (or null for `deny` with no credential) + whether it came from the session cookie.
 */
export async function resolveIdentity(
  headers: Headers,
  config: AuthConfig,
  deps: ResolveDeps = {},
): Promise<IdentityResolution> {
  // 1. Session cookie (oidc).
  if (config.mode === "oidc" && deps.validateSessionCookie) {
    const token = readCookie(headers, SESSION_COOKIE);
    if (token) {
      const identity = await deps.validateSessionCookie(token);
      if (identity) return { identity, viaCookie: true, viaFallback: false };
    }
  }
  // 2. Forward-auth header (forward-header).
  if (config.mode === "forward-header") {
    const identity = await resolveForwardHeader(headers, config.verifyForwardJwt);
    if (identity) return { identity, viaCookie: false, viaFallback: false };
  }
  // 3. Fallback.
  if (config.fallback === "owner") {
    return {
      identity: { externalId: null, handle: config.defaultHandle, groups: [] },
      viaCookie: false,
      viaFallback: true,
    };
  }
  return { identity: null, viaCookie: false, viaFallback: false };
}

/**
 * Back-compat handle-only wrapper (docs/auth-and-credentials-plan.md §2). The existing non-tRPC
 * callers (export/import/asset routes) only need a handle for ownerId scoping; they keep working with
 * just an added `await`. NOW async because the underlying resolution does I/O (cookie→DB, JWKS verify).
 * Returns DEFAULT_USER_HANDLE when there's no credential (the `owner` fallback) — callers that must
 * enforce auth use the tRPC `authedProcedure`/resolveIdentity directly instead.
 */
export async function resolveUsername(headers: Headers, deps: ResolveDeps = {}): Promise<string> {
  const { identity } = await resolveIdentity(headers, authConfigFromEnv(), deps);
  return identity?.handle ?? env.DEFAULT_USER_HANDLE;
}
