// Local-password hashing for AUTH_MODE=local (docs/auth/auth-and-credentials-plan.md — the `local`
// mode section). Self-contained, zero new deps: Node's built-in `node:crypto` scrypt with a per-user
// random salt. We do NOT use a shared server salt (the SillyTavern weakness) — every hash carries its
// own salt, so two users with the same password get different hashes and a stolen DB can't be
// rainbow-tabled. The verify compare is constant-time (`timingSafeEqual`), unlike ST's plaintext `===`.
//
// Stored format is a single self-describing string (no separate salt column needed):
//   scrypt$<saltBase64>$<hashBase64>
// The leading algorithm tag leaves room to migrate the KDF later without a schema change.
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { env } from "../env";

const scrypt = promisify(scryptCb);

// Server-wide PEPPER: HMAC the cleartext with SESSION_SECRET before scrypt, so a stolen DB alone can't
// brute-force passwords offline — the same "a DB leak isn't enough" posture as the session tokenHash
// (sessions/service.ts) and the CREDENTIALS_KEY-encrypted user creds. AUTH_MODE=local requires
// SESSION_SECRET (env refinement), so the pepper is always present there; the `?? ""` is a defensive
// floor for the non-local code paths that never mint a local password. Rotating SESSION_SECRET
// invalidates all local passwords (same blast radius as it invalidating sessions) — documented.
function pepper(plain: string): string {
  return createHmac("sha256", env.SESSION_SECRET ?? "")
    .update(plain.normalize())
    .digest("base64");
}

const ALGO = "scrypt";
const SALT_BYTES = 16;
const KEY_LEN = 64;
// Minimum cleartext length enforced at the hashing boundary (the route/proc also validate, but this is
// the last line — a too-short password should never reach storage). Matches LOCAL_INITIAL_PASSWORD.
export const MIN_PASSWORD_LENGTH = 8;

/** Hash a cleartext password into the self-contained `scrypt$salt$hash` form. Throws if too short. */
export async function hashPassword(plain: string): Promise<string> {
  const normalized = plain.normalize();
  if (normalized.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(pepper(normalized), salt, KEY_LEN)) as Buffer;
  return `${ALGO}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Constant-time verify of a cleartext password against a stored `scrypt$salt$hash` string. Returns
 * false (never throws) for a null/empty/malformed stored value or any mismatch — so a caller can pass
 * a user's nullable `passwordHash` straight in and an SSO-only row (null hash) simply fails to log in.
 */
export async function verifyPassword(
  plain: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== ALGO) return false;
  const [, saltB64, hashB64] = parts as [string, string, string];
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = (await scrypt(pepper(plain), salt, expected.length)) as Buffer;
  // Lengths match by construction (we derived `expected.length`), so timingSafeEqual is safe to call.
  return timingSafeEqual(derived, expected);
}
