import type { Db } from "../../../db/client";
import type { SecretBox } from "../../crypto/secrets";
import { clearUserKey, hasUserKey, storeUserKey } from "../_shared/credentials";
import { ensureUser } from "../_shared/users";

// Caller-scoped per-user credential management (docs/auth-and-credentials-plan.md §7) — the tRPC-facing
// thin wrapper over the _shared store. The plaintext key is never stored (encrypted at rest) and never
// returned (only `hasMyOpenRouterKey`). Not admin — a user manages their OWN key.
export interface CredentialsService {
  setMyOpenRouterKey(params: { username: string; key: string }): Promise<{ ok: true }>;
  clearMyOpenRouterKey(params: { username: string }): Promise<{ ok: true }>;
  hasMyOpenRouterKey(params: { username: string }): Promise<{ has: boolean }>;
}

export function createCredentialsService(db: Db, box: SecretBox): CredentialsService {
  return {
    async setMyOpenRouterKey({ username, key }) {
      const ownerId = await ensureUser(db, username);
      await storeUserKey(db, box, ownerId, "openrouter", key.trim());
      return { ok: true };
    },
    async clearMyOpenRouterKey({ username }) {
      const ownerId = await ensureUser(db, username);
      await clearUserKey(db, ownerId, "openrouter");
      return { ok: true };
    },
    async hasMyOpenRouterKey({ username }) {
      const ownerId = await ensureUser(db, username);
      return { has: await hasUserKey(db, ownerId, "openrouter") };
    },
  };
}
