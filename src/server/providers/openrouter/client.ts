import { OpenRouter } from "@openrouter/sdk";
import { env } from "../../env";

let client: OpenRouter | null = null;

export function isOpenRouterConfigured(): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

export function getOpenRouterClient(): OpenRouter {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set; the OpenRouter runner is unavailable.");
  }
  if (!client) {
    client = new OpenRouter({ apiKey });
  }
  return client;
}
