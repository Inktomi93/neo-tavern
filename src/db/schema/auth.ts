import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./tenancy";

// ───────────────────────── App auth (BFF sessions + per-user credentials) ─────────────────────────
// The app CONSUMES identity (authentik), never an IdP. These two tables back the locked auth design
// in docs/auth-and-credentials-plan.md — they exist NOW so no follow-up migration is needed when the
// OIDC routes + credential resolver land. NOT to be confused with `session_entries` (schema/session.ts),
// which is the SDK transcript resume-cache; THIS `sessions` table is the browser↔app login session.

// The revocable, server-side browser session (the BFF pattern). After the OIDC callback we mint an
// OPAQUE random token (32 bytes, base64url) and store only its HASH here (HMAC-peppered by
// SESSION_SECRET so a DB leak alone can't forge one); the token rides in an HttpOnly/Secure/
// SameSite=Lax cookie. Every request hashes the cookie → looks the row up here → valid iff the row
// exists, is not `revokedAt`, is not past `expiresAt`, AND the owning users.enabled. Server-side =
// logout/disable/kick-a-device take effect on the very next request (not at expiry). Sliding expiry
// bumps expiresAt/lastSeenAt on use.
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }), // a user's sessions die with the user
    // SHA-256/HMAC of the opaque cookie token — never the token itself. Unique: one row per token.
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(), // bumped on each validated request (sliding)
    expiresAt: integer("expires_at").notNull(), // epoch-ms; slid forward on use
    revokedAt: integer("revoked_at"), // set on logout / admin revoke → rejected immediately
    userAgent: text("user_agent"), // device label for "list/revoke my sessions"
    label: text("label"), // optional human label (future API tokens reuse this store)
  },
  (t) => [index("sessions_user_idx").on(t.userId)], // backs listSessions / revokeAllForUser
);

// Per-user encrypted provider credential (bring-your-own OpenRouter key — the non-owner's path to
// paid generation without touching the owner's Max sub). AES-256-GCM at rest (an upgrade over ST's
// plaintext secrets.json): ciphertext/iv/tag stored separately, AAD bound to `${userId}|${provider}`
// so a row can't be lifted into another user's/provider's slot and still decrypt. The plaintext key
// is NEVER stored and NEVER returned by any API (only a `hasMyOpenRouterKey: boolean`).
export const userCredentials = sqliteTable(
  "user_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["openrouter"] }).notNull(),
    ciphertext: text("ciphertext").notNull(), // base64 AES-256-GCM ciphertext
    iv: text("iv").notNull(), // base64 12-byte random IV (fresh per encryption)
    tag: text("tag").notNull(), // base64 GCM auth tag
    label: text("label"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  // One stored key per (user, provider) — setMyOpenRouterKey upserts on this.
  (t) => [uniqueIndex("user_credentials_user_provider_unq").on(t.userId, t.provider)],
);
