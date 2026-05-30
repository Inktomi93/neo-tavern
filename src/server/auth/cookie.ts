import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE_NAME } from "./trust-header";

// Shared session-cookie write helpers — used by BOTH session-minting modes (oidc: auth-oidc.ts,
// local: auth-local.ts) so the locked §11 cookie contract lives in exactly one place. The cookie name
// (`__Host-`-prefixed) is owned by trust-header.ts; these set/clear it consistently.

// The session cookie attributes (the §11 contract): HttpOnly (an XSS can't read it), Secure (no
// plaintext-http session — ALSO required by the `__Host-` prefix), SameSite=Lax (blocks cross-site
// POST but rides the top-level OAuth callback redirect), Path "/" + NO Domain (the other two `__Host-`
// requirements). So the host-binding holds.
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Set the session cookie for a freshly-minted session (maxAge derived from the session's expiry). */
export function setSessionCookie(c: Context, token: string, expiresAt: number): void {
  setCookie(
    c,
    SESSION_COOKIE_NAME,
    token,
    sessionCookieOptions(Math.floor((expiresAt - Date.now()) / 1000)),
  );
}

/** Clear the session cookie on logout. `secure: true` is required to expire a `__Host-` cookie (the
 *  clearing Set-Cookie must itself be a valid __Host- cookie), or the browser ignores it. */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/", secure: true });
}
