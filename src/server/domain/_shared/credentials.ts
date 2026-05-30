import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { userCredentials, users } from "../../../db/schema";
import type { SecretBox } from "../../crypto/secrets";
import { env } from "../../env";
import { getLog } from "../../observability/logger";
import { DomainForbiddenError, DomainOperationError } from "./errors";
import { newId } from "./ids";

// Per-user credential store + the turn-time credential RESOLVER (docs/auth/auth-and-credentials-plan.md
// §7/§8). Lives in _shared (not a feature) so the chat verbs can call the resolver without a
// cross-feature import, and the `credentials` feature service can reuse the store. The SecretBox is
// injected (built from env at the composition root) so encryption is testable + degrades when no key
// is configured. AAD = `${userId}|${provider}` binds every ciphertext to its slot.

type CredProvider = "openrouter";

const aadFor = (userId: string, provider: CredProvider): string => `${userId}|${provider}`;

/** Encrypt + upsert a user's provider key. Throws if encryption is disabled (no CREDENTIALS_KEY). */
export async function storeUserKey(
  db: Db,
  box: SecretBox,
  userId: string,
  provider: CredProvider,
  plaintext: string,
): Promise<void> {
  if (!box.enabled) {
    throw new DomainOperationError(
      "credentials_disabled",
      "Per-user credential storage is disabled (no CREDENTIALS_KEY configured).",
    );
  }
  const sealed = box.encrypt(plaintext, aadFor(userId, provider));
  const now = Date.now();
  await db
    .insert(userCredentials)
    .values({
      id: newId(),
      userId,
      provider,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      tag: sealed.tag,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userCredentials.userId, userCredentials.provider],
      set: { ciphertext: sealed.ciphertext, iv: sealed.iv, tag: sealed.tag, updatedAt: now },
    });
  getLog().info({ userId, provider }, "credentials: stored user key");
}

/** Whether a user has a stored key (row existence only — never decrypts; the API only exposes this). */
export async function hasUserKey(db: Db, userId: string, provider: CredProvider): Promise<boolean> {
  const rows = await db
    .select({ id: userCredentials.id })
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.provider, provider)))
    .limit(1);
  return rows.length > 0;
}

export async function clearUserKey(db: Db, userId: string, provider: CredProvider): Promise<void> {
  await db
    .delete(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.provider, provider)));
  getLog().info({ userId, provider }, "credentials: cleared user key");
}

// Read + decrypt a user's key, or null when absent / encryption-off / undecryptable. A decrypt failure
// (corrupt row or a rotated key) degrades to null (→ host-key fallback) rather than crashing the turn,
// logged loudly so the cause is visible.
async function readUserKey(
  db: Db,
  box: SecretBox,
  userId: string,
  provider: CredProvider,
): Promise<string | null> {
  if (!box.enabled) return null;
  const rows = await db
    .select({
      ciphertext: userCredentials.ciphertext,
      iv: userCredentials.iv,
      tag: userCredentials.tag,
    })
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.provider, provider)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    return box.decrypt(row, aadFor(userId, provider));
  } catch (err) {
    getLog().error(
      { userId, provider, err: err instanceof Error ? err.message : String(err) },
      "credentials: failed to decrypt user key (treating as absent — check CREDENTIALS_KEY)",
    );
    return null;
  }
}

/** What a turn authenticates with. Discriminated so the runner picks the env target. */
export type ResolvedCredential =
  | { source: "max-pro-sub" }
  | { source: "openrouter"; openRouterKey: string };

/**
 * THE turn-time credential chokepoint (§8) — the single home of the access guard (replaces the old
 * startChat handle-check). Called by every chat verb before running.
 *   • max-pro-sub → the host `claude login`; allowed IFF the user is an admin, else DomainForbiddenError.
 *     There is no per-user Claude sub.
 *   • openrouter  → the user's own (decrypted) key if present, else the host OPENROUTER_API_KEY
 *     fallback, else DomainOperationError. (The host key is a temporary fallback; per-user keys are
 *     the goal.)
 */
export async function resolveCredential(
  db: Db,
  box: SecretBox,
  ownerId: string,
  source: "max-pro-sub" | "openrouter",
): Promise<ResolvedCredential> {
  if (source === "max-pro-sub") {
    const rows = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    if (rows[0]?.role !== "admin") {
      throw new DomainForbiddenError(
        "max-pro-sub is the owner's credential; bring your own OpenRouter key.",
      );
    }
    return { source: "max-pro-sub" };
  }
  const key = (await readUserKey(db, box, ownerId, "openrouter")) ?? env.OPENROUTER_API_KEY ?? null;
  if (!key) {
    throw new DomainOperationError(
      "no_openrouter_credential",
      "No OpenRouter credential — add your own key in settings.",
    );
  }
  return { source: "openrouter", openRouterKey: key };
}
