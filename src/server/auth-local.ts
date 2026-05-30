import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { castId, type UserId } from "../shared/ids";
import { clearSessionCookie, setSessionCookie } from "./auth/cookie";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./auth/password";
import { hasCsrfHeader, SESSION_COOKIE_NAME } from "./auth/trust-header";
import { ensureUser } from "./domain/_shared/users";
import type { SessionsService } from "./domain/sessions";
import { env } from "./env";
import { getLog, securityEvent } from "./observability/logger";

// A minimal in-memory per-IP fixed-window throttle on the login route — the only unauthenticated,
// CPU-heavy (scrypt) endpoint `local` mode opens. This is a stopgap until the general rate-limiter
// (breadth-buildout A.2.2) lands; it caps brute-force + scrypt-flood DoS without a dep. Single-process
// (the deploy is one container); a Map is fine.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_PER_WINDOW = 10;
const loginHits = new Map<string, { count: number; resetAt: number }>();

function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  // Opportunistic prune so the Map can't grow unbounded under a spoofed-IP flood.
  if (loginHits.size > 10_000) {
    for (const [k, v] of loginHits) if (v.resetAt <= now) loginHits.delete(k);
  }
  const entry = loginHits.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginHits.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > LOGIN_MAX_PER_WINDOW;
}

/** Best-effort client IP for the login throttle (leftmost X-Forwarded-For → X-Real-IP → "unknown").
 *  Worst case (no headers) all anonymous attempts share one "unknown" bucket — still a throttle. */
function loginClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip")?.trim() || "unknown";
}

// Local username+password auth (AUTH_MODE=local) — the no-SSO path. Mirrors the OIDC routes
// (auth-oidc.ts) but the session is minted by verifying a stored password instead of an OIDC code
// exchange. Everything downstream is identical: the same `__Host-neo_session` cookie, the same
// sessions service, the same tRPC/CSRF/role machinery reads it (trust-header.ts cookie layer now runs
// for `local` too). The app stores password hashes (auth/password.ts: scrypt + per-user salt +
// SESSION_SECRET pepper), making `local` a MINIMAL password IdP — the one place we deviate from the
// "only ever consume identity" stance, by owner decision, for users without authentik/authelia.

/**
 * Seed the owner account's password on boot (idempotent). In `local` mode the env refinement
 * guarantees LOCAL_INITIAL_PASSWORD is set. Creates the owner row if absent (ensureUser → admin by the
 * DEFAULT_USER_HANDLE rule) and sets its passwordHash ONLY when currently null — so a password the
 * owner later changes is never clobbered by a redeploy.
 */
export async function seedLocalOwner(db: Db): Promise<void> {
  if (env.AUTH_MODE !== "local") return;
  const initial = env.LOCAL_INITIAL_PASSWORD;
  if (!initial) return; // refinement guarantees this in local mode; defensive.
  const ownerId = await ensureUser(db, env.DEFAULT_USER_HANDLE);
  const rows = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (rows[0]?.passwordHash) return; // already has a (possibly changed) password — leave it.
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(initial) })
    .where(eq(users.id, ownerId));
  getLog().info({ handle: env.DEFAULT_USER_HANDLE }, "auth: seeded local owner password");
}

/**
 * Register the local-auth routes — only in `local` mode (no-op otherwise, like registerOidcRoutes).
 * All public Hono routes (not behind the tRPC 401 gate). Generic "Invalid credentials" on any login
 * failure (no user-enumeration: same response whether the handle is unknown, the password is wrong, or
 * the account is disabled / SSO-only).
 */
export function registerLocalAuthRoutes(app: Hono, db: Db, sessions: SessionsService): void {
  if (env.AUTH_MODE !== "local") return;

  // bodyLimit caps the login body (credentials are tiny) so a huge POST can't be a DoS vector ahead of
  // the general body-limit work (A.2.4).
  app.post("/api/auth/login", bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    if (loginRateLimited(loginClientIp(c))) {
      return c.json({ error: "Too many attempts; try again shortly." }, 429);
    }
    let body: { handle?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body." }, 400);
    }
    const handle = typeof body.handle === "string" ? body.handle.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!handle || !password) {
      return c.json({ error: "Invalid credentials." }, 401);
    }
    const rows = await db
      .select({ id: users.id, enabled: users.enabled, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1);
    const user = rows[0];
    // CONSTANT-TIME floor: an unknown handle / disabled / SSO-only (null hash) user verifies against a
    // dummy hash so scrypt ALWAYS runs — no timing oracle distinguishing "no such user" from "wrong
    // password" (both pay one scrypt). The body response was already uniform; this closes the timing gap.
    const storedForVerify =
      user?.enabled === true && user.passwordHash ? user.passwordHash : DUMMY_PASSWORD_HASH;
    const passwordOk = await verifyPassword(password, storedForVerify);
    const authed = user?.enabled === true && user.passwordHash != null && passwordOk;
    if (!authed || !user) {
      securityEvent("login_failed", { handle });
      return c.json({ error: "Invalid credentials." }, 401);
    }
    const { token, expiresAt } = await sessions.create({
      userId: castId<UserId>(user.id),
      userAgent: c.req.header("user-agent") ?? null,
    });
    setSessionCookie(c, token, expiresAt);
    getLog().info({ handle, userId: user.id }, "auth: local login");
    return c.json({ ok: true, handle });
  });

  app.post("/api/auth/logout", async (c) => {
    // Logout is state-changing (revokes the session), so require the CSRF header like every cookie
    // mutation — otherwise a cross-site top-level POST (SameSite=Lax rides the cookie) could force-logout.
    if (!hasCsrfHeader(c.req.raw.headers)) {
      return c.json({ error: "Missing CSRF header." }, 403);
    }
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
