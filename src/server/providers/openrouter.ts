import OpenAI from "openai";
import { env } from "../env";

// Raw-mode + non-Claude chats route through OpenRouter via the OpenAI-compatible
// API. The client is lazily constructed so the server boots without a key set;
// the key is only required the moment a raw-mode chat actually calls out.
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

let client: OpenAI | null = null;

export function isOpenRouterConfigured(): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

export function getOpenRouterClient(): OpenAI {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set; raw-mode / non-Claude chats are unavailable.");
  }

  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      // OpenRouter attribution headers (used for its dashboard/leaderboards).
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/Inktomi93/neo-tavern",
        "X-Title": "neo-tavern",
      },
    });
  }

  return client;
}
