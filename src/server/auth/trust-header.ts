// The auth seam — LAYERED identity resolution (docs/auth/auth-and-credentials-plan.md §2).
//
// The app only CONSUMES identity, never an IdP. `AUTH_MODE` picks the SSO mechanism and
// `AUTH_FALLBACK` decides the un-credentialed case; the layers are tried in order PER REQUEST:
//   1. session cookie     (oidc)            → an opaque token validated against the `sessions` table
//   2. forward-auth header (forward-header) → X-Authentik-* trusted by verifying X-Authentik-Jwt (JWKS)
//   3. fallback                              → owner (DEFAULT_USER_HANDLE) or deny (null → 401)
// so `oidc` + `owner` = SSO on the domain AND owner on the raw LAN IP, from one process.
//
// ORIGIN-GATED FALLBACK (the load-bearing safety property): in an SSO mode the `owner` fallback is
// granted ONLY for a LOCAL origin (see `isLocalOrigin`) — the raw-LAN-IP path. On the public FQDN an
// un-credentialed request resolves to null (→ 401), so SSO is mandatory there. WITHOUT this gate,
// `oidc`+`owner` would hand every anonymous public request owner+admin (the resolver can't otherwise
// tell a public-domain request from a raw-LAN one — both are just "un-cookied request to this process").
// In `single-user` mode the fallback is UNCONDITIONAL (it is the only way in — the locked zero-infra
// contract). The Host header is trustworthy here ONLY because Caddy routes by the real Host (a spoofed
// private-IP Host never matches the site → never reaches this process) and :8788 is not publicly
// routable (the CLAUDE.md deployment invariant); see docs/auth/auth-deploy.md.
//
// LAYER RULE (docs/architecture/architecture.md): `auth` is infrastructure — it must NOT import `domain`. The two
// db-dependent pieces (the session lookup; the user upsert) are therefore INJECTED by the composition
// root, keeping this module db-free + unit-testable. `provisionIdentity` (the upsert) lives in
// domain/_shared/users.ts; the cookie validator comes from the sessions domain service.
import { createLocalJWKSet, createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { ResolvedIdentity } from "../../shared/identity";
import { env } from "../env";
import { getLog } from "../observability/logger";
import { DEFAULT_TRUSTED_RANGES, isInRanges } from "./ip-ranges";

/** The bits of config the resolver needs, passed explicitly so unit tests can vary mode/fallback
 *  without re-parsing env. `authConfigFromEnv()` builds the live one. */
export interface AuthConfig {
  mode: "single-user" | "local" | "forward-header" | "oidc";
  fallback: "owner" | "deny";
  defaultHandle: string;
  verifyForwardJwt: boolean;
  // Extra hostnames trusted as a LOCAL origin for the owner fallback in SSO modes (private/loopback IP
  // literals + `localhost` are always local and need no entry). The public FQDN must NEVER appear here.
  trustedLocalHosts: string[];
  // Extra CIDR ranges (env TRUSTED_PRIVATE_RANGES) added to the built-in private set for the local-origin
  // gate — e.g. a custom Tailscale subnet-router range or a non-default Docker network. Optional; absent
  // ⇒ just the built-in DEFAULT_TRUSTED_RANGES (loopback/RFC1918/Tailscale/link-local/ULA).
  trustedPrivateRanges?: string[];
  // Custom trusted-header NAMES for the UNSIGNED forward-header path (override the known authentik/
  // authelia families for an arbitrary proxy). All optional; absent ⇒ auto-accept both known families.
  forwardUserHeader?: string;
  forwardGroupsHeader?: string;
  forwardUidHeader?: string;
  // OPT-IN source-IP gate for the unsigned path: CIDRs the forwarded request's client IP must match.
  // Empty/absent ⇒ no gate (network-isolation trust). The signed-JWT path never consults this.
  forwardTrustedProxies?: string[];
}

/** Injected, db-dependent resolution steps (wired at the composition root; absent ⇒ that layer is
 *  inert). Keeps this infra module from importing the domain/db layers it sits below. */
export interface ResolveDeps {
  /** Validate a `__Host-neo_session` cookie token → identity, or null if missing/revoked/expired/disabled.
   *  Backed by the sessions domain service (which enforces users.enabled every request). oidc only. */
  validateSessionCookie?: (token: string) => Promise<ResolvedIdentity | null>;
}

/** What the resolver returns: the identity (or null when denied) + how it was resolved.
 *  - `viaCookie` is the per-request CSRF signal (a cookie request has a cross-site surface; a
 *    header/fallback request does not).
 *  - `viaFallback` marks the un-credentialed owner-fallback path — the SAFE discriminator for "this
 *    IS the owner" (a forward-header identity may also have externalId === null when no uid header was
 *    forwarded, so externalId-null alone must NOT be read as "owner"). The seam role-resolves the
 *    non-fallback (SSO) identities; the fallback is the owner/admin without a DB touch. In SSO modes
 *    this is only ever true on a local origin (see `ownerFallbackAllowed`). */
export interface IdentityResolution {
  identity: ResolvedIdentity | null;
  viaCookie: boolean;
  viaFallback: boolean;
}

// The session cookie name carries the `__Host-` prefix (2026 hardening): the browser binds the cookie
// to the EXACT host and rejects any Set-Cookie that lacks Secure / Path=/ or carries a Domain — which
// kills subdomain cookie-injection + fixation. `sessionCookieOptions` (auth-oidc.ts) satisfies those.
// This literal name is the single source of truth — the raw `readCookie` parser below AND the Hono
// helpers in auth-oidc.ts use it verbatim. OWASP's gold-standard session-cookie name.
export const SESSION_COOKIE_NAME = "__Host-neo_session";
const CSRF_HEADER = "x-neo-csrf";

export function authConfigFromEnv(): AuthConfig {
  return {
    mode: env.AUTH_MODE,
    fallback: env.AUTH_FALLBACK,
    defaultHandle: env.DEFAULT_USER_HANDLE,
    verifyForwardJwt: env.FORWARD_AUTH_VERIFY_JWT,
    trustedLocalHosts: parseHostList(env.TRUSTED_LOCAL_HOSTS),
    trustedPrivateRanges: parseCsv(env.TRUSTED_PRIVATE_RANGES),
    ...(env.FORWARD_AUTH_USER_HEADER ? { forwardUserHeader: env.FORWARD_AUTH_USER_HEADER } : {}),
    ...(env.FORWARD_AUTH_GROUPS_HEADER
      ? { forwardGroupsHeader: env.FORWARD_AUTH_GROUPS_HEADER }
      : {}),
    ...(env.FORWARD_AUTH_UID_HEADER ? { forwardUidHeader: env.FORWARD_AUTH_UID_HEADER } : {}),
    forwardTrustedProxies: parseCsv(env.FORWARD_AUTH_TRUSTED_PROXIES),
  };
}

/** Parse a comma-list env value into trimmed non-empty entries (CIDR strings, header names, …). */
function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse the TRUSTED_LOCAL_HOSTS comma-list into normalized (lowercased, port-stripped) hostnames. */
function parseHostList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((h) => normalizeHost(h))
    .filter((h) => h.length > 0);
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

/** The request's apparent client IP for the opt-in trusted-proxy gate: the leftmost X-Forwarded-For
 *  hop (Caddy sets it to the real client), falling back to X-Real-IP. null when neither is present. */
function clientIpFromHeaders(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || null;
}

/** Read an UNSIGNED forwarded identity from the configured/known trusted headers. Order: a custom
 *  override (FORWARD_AUTH_USER_HEADER), then the authentik family (X-Authentik-*), then the Authelia
 *  family (Remote-*). Authelia has no stable uid → externalId stays null (provisionIdentity then keys
 *  on handle). Returns null when no known user header is present. */
function readUnsignedIdentity(headers: Headers, config: AuthConfig): ResolvedIdentity | null {
  if (config.forwardUserHeader) {
    const handle = headers.get(config.forwardUserHeader);
    if (!handle) return null;
    const externalId = config.forwardUidHeader ? headers.get(config.forwardUidHeader) : null;
    const groups = config.forwardGroupsHeader
      ? groupsFromClaim(headers.get(config.forwardGroupsHeader))
      : [];
    return { externalId, handle, groups };
  }
  const authentik = headers.get("x-authentik-username");
  if (authentik) {
    return {
      externalId: headers.get("x-authentik-uid"),
      handle: authentik,
      groups: groupsFromClaim(headers.get("x-authentik-groups")),
    };
  }
  const authelia = headers.get("remote-user");
  if (authelia) {
    return {
      externalId: null,
      handle: authelia,
      groups: groupsFromClaim(headers.get("remote-groups")),
    };
  }
  return null;
}

// forward-header layer. When FORWARD_AUTH_VERIFY_JWT is on AND authentik forwarded a signed JWT (+ the
// JWKS to verify it), trust the CLAIMS — cryptographic, spoof-proof regardless of network path (§1c);
// the signed path SKIPS the source-IP gate (the signature is the proof). Otherwise it's network-trust
// of the raw headers — authentik X-Authentik-*, Authelia Remote-*, or a custom-named proxy — guarded by
// the OPT-IN FORWARD_AUTH_TRUSTED_PROXIES source-IP gate (unset ⇒ no gate, today's behavior). Returns
// null when no usable identity is present.
async function resolveForwardHeader(
  headers: Headers,
  config: AuthConfig,
): Promise<ResolvedIdentity | null> {
  const jwt = headers.get("x-authentik-jwt");
  const metaJwks = headers.get("x-authentik-meta-jwks");
  if (config.verifyForwardJwt && jwt && metaJwks) {
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
  // Unsigned network-trust path (verify off, or no JWT forwarded): the raw headers.
  const identity = readUnsignedIdentity(headers, config);
  if (!identity) return null;
  // OPT-IN source-IP gate: if FORWARD_AUTH_TRUSTED_PROXIES is configured, the forwarded request's client
  // IP must fall inside it — else reject (a request reaching :8788 from outside the trusted ranges can't
  // forge Remote-User). Unset ⇒ skip (network-isolation trust, the deployment invariant is the boundary).
  const proxies = config.forwardTrustedProxies;
  if (proxies && proxies.length > 0) {
    const ip = clientIpFromHeaders(headers);
    if (!ip || !isInRanges(ip, proxies)) {
      getLog().warn(
        { ip, handle: identity.handle },
        "auth: forwarded identity from an untrusted source IP — rejecting",
      );
      return null;
    }
  }
  return identity;
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
  // 1. Session cookie (oidc OR local — both mint the SAME __Host-neo_session via the sessions service;
  //    only HOW the session is created differs [OIDC callback vs password login], not how it's read).
  if ((config.mode === "oidc" || config.mode === "local") && deps.validateSessionCookie) {
    const token = readCookie(headers, SESSION_COOKIE_NAME);
    if (token) {
      const identity = await deps.validateSessionCookie(token);
      if (identity) return { identity, viaCookie: true, viaFallback: false };
    }
  }
  // 2. Forward-auth header (forward-header).
  if (config.mode === "forward-header") {
    const identity = await resolveForwardHeader(headers, config);
    if (identity) return { identity, viaCookie: false, viaFallback: false };
  }
  // 3. Fallback — owner ONLY when permitted for this request's origin (see ownerFallbackAllowed).
  if (config.fallback === "owner" && ownerFallbackAllowed(headers, config)) {
    return {
      identity: { externalId: null, handle: config.defaultHandle, groups: [] },
      viaCookie: false,
      viaFallback: true,
    };
  }
  return { identity: null, viaCookie: false, viaFallback: false };
}

/**
 * Whether the un-credentialed `owner` fallback may be granted for THIS request.
 *  - `single-user`: ALWAYS (the fallback is the only way in — the locked zero-infra contract; this box
 *    trusts no forwarded headers/cookies, so the origin is irrelevant).
 *  - SSO modes (`oidc`/`forward-header`): only on a LOCAL origin (the raw-LAN-IP path). On the public
 *    FQDN the fallback is refused → the request resolves to null → 401, making SSO mandatory there.
 *    This is the gate that keeps `oidc`+`owner` from handing anonymous public requests owner+admin.
 */
function ownerFallbackAllowed(headers: Headers, config: AuthConfig): boolean {
  if (config.mode === "single-user") return true;
  // `local` behaves like the SSO modes here: the owner fallback is granted only on a LOCAL origin (the
  // raw-LAN/Tailscale path); on the public host an un-cookied request gets null → 401 → must log in.
  return isLocalOrigin(headers, config.trustedLocalHosts, config.trustedPrivateRanges);
}

/**
 * Is the request targeting a trusted LOCAL origin? Keys on the `Host` header (the host the CLIENT
 * targeted): a private/loopback IP literal, `localhost`, or a configured trusted hostname. We read
 * `Host` (not `X-Forwarded-Host`) deliberately — a proxy-rewritten Host can only REMOVE trust (→ SSO),
 * never grant it. Safe because Caddy routes by the real Host (a spoofed private-IP Host never reaches
 * this process) and :8788 is not publicly routable (the deployment invariant). Fails closed.
 */
export function isLocalOrigin(
  headers: Headers,
  trustedHosts: string[],
  extraRanges: string[] = [],
): boolean {
  const rawHost = headers.get("host");
  if (!rawHost) return false;
  const host = normalizeHost(rawHost);
  if (host.length === 0) return false;
  if (host === "localhost") return true;
  if (trustedHosts.includes(host)) return true;
  // A private/loopback/Tailscale/link-local IP literal (the shared matcher; a hostname won't parse → no
  // match → SSO required). The env-extra CIDRs widen the built-in set without replacing it.
  const ranges =
    extraRanges.length > 0 ? [...DEFAULT_TRUSTED_RANGES, ...extraRanges] : DEFAULT_TRUSTED_RANGES;
  return isInRanges(host, ranges);
}

/** Lowercase + strip the :port, handling the bracketed IPv6 form (`[::1]:8788` → `::1`). */
function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h.slice(1) : h.slice(1, end); // inside the brackets (bare IPv6)
  }
  const colon = h.indexOf(":");
  // A single colon = host:port (IPv4/hostname); many colons = a bare IPv6 literal (leave intact).
  if (colon !== -1 && colon === h.lastIndexOf(":")) return h.slice(0, colon);
  return h;
}

// (Private-range matching moved to ./ip-ranges.ts — one home, now incl. Tailscale CGNAT 100.64.0.0/10
// and proper CIDR matching for the env-configured allowlist/trusted-proxy lists.)

// NOTE: the old `resolveUsername` back-compat wrapper was REMOVED — it ignored the cookie layer and
// fell back to the owner handle UNCONDITIONALLY (even under AUTH_FALLBACK=deny), so the export/import/
// upload routes that used it were anonymously owner-scoped. Those routes now resolve auth through the
// composition-root seam (server/auth-context.ts `resolveOwner`), which enforces identity !== null.
