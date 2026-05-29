import { OpenRouter } from "@openrouter/sdk";
import { env } from "../../env";

// Per-KEY client cache (docs/auth-and-credentials-plan.md §9): one OpenRouter client per distinct API
// key, so a per-user (BYO) key never leaks into another user's client. The turn runners pass the
// resolved key; the host-account surfaces (catalog/credits/...) use the shared host key.
const clients = new Map<string, OpenRouter>();

export function isOpenRouterConfigured(): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

/** Get (or build + cache) the client for a specific API key. The key is required — the turn-time
 *  credential resolver guarantees one before any turn runs. */
export function getOpenRouterClient(apiKey: string): OpenRouter {
  if (!apiKey) {
    throw new Error("getOpenRouterClient: an OpenRouter API key is required.");
  }
  let client = clients.get(apiKey);
  if (!client) {
    client = new OpenRouter({ apiKey });
    clients.set(apiKey, client);
  }
  return client;
}

/** The client for the HOST OpenRouter key (env) — used by the account/catalog surfaces (credits,
 *  activity, providers, endpoints, model list), which are host-account-scoped, not per-turn. Throws
 *  if no host key is configured. (The host key is a temporary fallback; per-user keys are the goal.) */
export function getHostOpenRouterClient(): OpenRouter {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set; the OpenRouter runner is unavailable.");
  }
  return getOpenRouterClient(apiKey);
}
