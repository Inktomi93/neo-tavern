import { createHmac, randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { sessions, users } from "../../../db/schema";
import type { ResolvedIdentity } from "../../../shared/identity";
import type { SessionView } from "../../../shared/session";
import { env } from "../../env";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";

export type { SessionView };

// The revocable, server-side browser session (the BFF pattern, docs/auth-and-credentials-plan.md §4).
// Pure DB + crypto — NO cookie I/O here (that's the route layer: the OIDC callback sets the cookie,
// logout clears it; resolveIdentity reads it). Sessions are minted only in oidc mode, where
// SESSION_SECRET is required (env refinement) — so hashing always has a pepper.

// 30-day sliding window; the slide WRITE is throttled (only when lastSeenAt is older than this) so an
// authenticated request burst doesn't write on every call. The enabled/revoked/expiry CHECKS still
// run every request — that's what makes disable/logout take effect on the very next request.
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SLIDE_THROTTLE_MS = 1000 * 60 * 5;

export interface SessionsService {
  /** Mint an opaque token (the caller sets it as the cookie) + persist only its peppered hash. */
  create(params: {
    userId: string;
    userAgent?: string | null;
  }): Promise<{ token: string; sessionId: string; expiresAt: number }>;
  /** Validate a cookie token → identity, or null if missing/revoked/expired/disabled. Slides expiry
   *  (throttled). This is the §2 cookie layer's injected validator. */
  validate(token: string): Promise<ResolvedIdentity | null>;
  /** Revoke the session a token belongs to (logout). No-op if already gone. */
  revokeByToken(token: string): Promise<void>;
  /** Revoke a session by id (admin: kick a specific device). */
  revoke(sessionId: string): Promise<void>;
  /** Revoke ALL of a user's live sessions (admin disable / kick-all) → count revoked. */
  revokeAllForUser(userId: string): Promise<number>;
  /** A user's sessions, newest-activity context for the admin list. */
  listForUser(userId: string): Promise<SessionView[]>;
}

// HMAC-pepper the token with SESSION_SECRET so a DB leak alone can't forge a session (the stored
// tokenHash is useless without the secret). Sessions exist only in oidc mode ⇒ SESSION_SECRET is set;
// the `?? ""` is a defensive floor (a non-oidc deploy never reaches here).
function hashToken(token: string): string {
  return createHmac("sha256", env.SESSION_SECRET ?? "")
    .update(token)
    .digest("hex");
}

export function createSessionsService(db: Db): SessionsService {
  async function create(params: {
    userId: string;
    userAgent?: string | null;
  }): Promise<{ token: string; sessionId: string; expiresAt: number }> {
    const token = randomBytes(32).toString("base64url");
    const id = newId();
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    await db.insert(sessions).values({
      id,
      userId: params.userId,
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      userAgent: params.userAgent ?? null,
    });
    getLog().info({ userId: params.userId, sessionId: id }, "session: created");
    return { token, sessionId: id, expiresAt };
  }

  async function validate(token: string): Promise<ResolvedIdentity | null> {
    const now = Date.now();
    const rows = await db
      .select({
        id: sessions.id,
        revokedAt: sessions.revokedAt,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        handle: users.handle,
        externalId: users.externalId,
        enabled: users.enabled,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, hashToken(token)))
      .limit(1);
    const s = rows[0];
    // Every gate runs per request → revoke/disable/expiry take effect on the NEXT request, not at TTL.
    if (!s || s.revokedAt !== null || s.expiresAt <= now || !s.enabled) {
      return null;
    }
    // Sliding expiry (throttled write).
    if (now - s.lastSeenAt > SLIDE_THROTTLE_MS) {
      await db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt: now + SESSION_TTL_MS })
        .where(eq(sessions.id, s.id));
    }
    return { externalId: s.externalId, handle: s.handle, groups: [] };
  }

  async function revokeByToken(token: string): Promise<void> {
    await db
      .update(sessions)
      .set({ revokedAt: Date.now() })
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
  }

  async function revoke(sessionId: string): Promise<void> {
    await db
      .update(sessions)
      .set({ revokedAt: Date.now() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    getLog().info({ sessionId }, "session: revoked");
  }

  async function revokeAllForUser(userId: string): Promise<number> {
    const live = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    if (live.length > 0) {
      await db
        .update(sessions)
        .set({ revokedAt: Date.now() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      getLog().info({ userId, count: live.length }, "session: revoked all for user");
    }
    return live.length;
  }

  async function listForUser(userId: string): Promise<SessionView[]> {
    return db
      .select({
        id: sessions.id,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(asc(sessions.createdAt));
  }

  return { create, validate, revokeByToken, revoke, revokeAllForUser, listForUser };
}
