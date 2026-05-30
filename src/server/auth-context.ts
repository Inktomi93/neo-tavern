// The composition-root AUTH SEAM — the one place allowed to wire `resolveIdentity` (the infra auth
// layer) together with `provisionIdentity`/`ensureUser` (the domain/db layer). It produces the
// `AuthContext` the tRPC procedure ladder gates on, AND the `resolveOwner` guard the non-tRPC Hono
// routes (export/import/asset-upload) use so they enforce the SAME identity check as tRPC instead of
// silently scoping to the owner. Lives in the entry layer (like auth-oidc.ts) — domain imports are
// allowed here; trust-header.ts (infra) must not reach up to them.

import type { Db } from "../db/client";
import type { AuthConfig } from "./auth/trust-header";
import { authConfigFromEnv, hasCsrfHeader, resolveIdentity } from "./auth/trust-header";
import { ensureUser, provisionIdentity } from "./domain/_shared/users";
import type { SessionsService } from "./domain/sessions";
import type { AuthContext } from "./trpc/context";

export interface AuthResolver {
  /** Resolve a request's headers → the AuthContext (identity/role/CSRF signal) the ladder gates on. */
  resolve(headers: Headers): Promise<AuthContext>;
}

/**
 * Build the request auth resolver. `config` is injectable so tests can exercise a specific
 * AUTH_MODE/fallback (env is parsed once at import, so it can't be varied per-test) — production omits
 * it and gets the live `authConfigFromEnv()`.
 *
 * The resolution mirrors the documented policy (docs/auth/auth-and-credentials-plan.md §2/§3):
 *   • no identity (deny, or owner-fallback refused on a public origin) → null → authedProcedure 401s.
 *   • owner fallback (raw-LAN path) → the admin owner, NO db touch + NO enabled gate (the owner is the
 *     owner by definition, not a revocable user).
 *   • SSO identity (cookie/forward-header) → provisionIdentity resolves role + the enabled gate
 *     (disabled → dropped to unauthenticated).
 */
export function createAuthResolver(deps: {
  db: Db;
  sessions: SessionsService;
  config?: AuthConfig;
}): AuthResolver {
  return {
    async resolve(headers: Headers): Promise<AuthContext> {
      const { identity, viaCookie, viaFallback } = await resolveIdentity(
        headers,
        deps.config ?? authConfigFromEnv(),
        { validateSessionCookie: (token) => deps.sessions.validate(token) },
      );
      const hasCsrf = hasCsrfHeader(headers);
      if (identity === null) {
        return { identity: null, viaCookie, hasCsrfHeader: hasCsrf, role: "user" };
      }
      if (viaFallback) {
        return { identity, viaCookie, hasCsrfHeader: hasCsrf, role: "admin" };
      }
      const { enabled, role } = await provisionIdentity(deps.db, identity);
      if (!enabled) {
        return { identity: null, viaCookie, hasCsrfHeader: hasCsrf, role: "user" };
      }
      return { identity, viaCookie, hasCsrfHeader: hasCsrf, role };
    },
  };
}

/** The owner-scoped result a Hono route guard returns: the resolved tenant + auth, or a refusal the
 *  route should turn into a JSON response with the given status. */
export type OwnerResolution =
  | { ok: true; ownerId: string; handle: string; auth: AuthContext }
  | { ok: false; status: 401 | 403; error: string };

/**
 * The non-tRPC route guard. Resolves the request's auth through the same seam as tRPC, then:
 *   • identity === null (no credential / owner-fallback refused on a public origin) → 401.
 *   • a COOKIE-authenticated MUTATION without the custom CSRF header → 403 (the §4 CSRF gate, applied
 *     to mutating routes only — `requireCsrf` false for safe GET downloads). Mirrors authedProcedure.
 *   • otherwise → the resolved tenant's `ownerId` (handle-keyed `ensureUser`, which converges with the
 *     SSO `provisionIdentity` row since `users.handle` is unique).
 */
export async function resolveOwner(
  resolver: AuthResolver,
  db: Db,
  headers: Headers,
  opts: { requireCsrf: boolean },
): Promise<OwnerResolution> {
  const auth = await resolver.resolve(headers);
  if (auth.identity === null) {
    return { ok: false, status: 401, error: "Authentication required." };
  }
  if (opts.requireCsrf && auth.viaCookie && !auth.hasCsrfHeader) {
    return { ok: false, status: 403, error: "Missing CSRF header." };
  }
  const ownerId = await ensureUser(db, auth.identity.handle);
  return { ok: true, ownerId, handle: auth.identity.handle, auth };
}
