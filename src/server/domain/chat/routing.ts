import {
  CHAT_MODELS,
  type ChatModelId,
  DEFAULT_CHAT_MODEL_ID,
  DEFAULT_RAW_MODEL_ID,
} from "../../../shared/models";
import type { PromptConfig } from "../../../shared/prompt-config";

// The SINGLE place model + provider selection happens, for every mode. send() never names a
// model or branches the runner on a hardcoded provider — it calls this once and acts on the
// result. Adding a new mode/provider (e.g. anthropic-direct) is a branch HERE, nowhere else.
//
// The split this encodes (consistent with the rest of the schema): the chat row holds the
// config for its NEXT turn (mode/provider/model), `messages.*` records what ACTUALLY ran
// (provenance). `chats.model` is mode-agnostic — interpreted against the mode's catalog. Model
// validity is checked at SELECTION time (the picker), not here on the hot send path; a stale
// stored id just falls back (sdk) or surfaces as the provider's model_unavailable (raw).

/** The minimal chat shape the resolver reads — structural so the unit test needs no DB. */
export interface RoutableChat {
  mode: "sdk" | "raw";
  provider: string;
  model: string | null;
  metadata: unknown;
}

/** What a turn runs as. Discriminated on `mode` so send() gets the right model type per runner. */
export type TurnRouting =
  | { mode: "sdk"; provider: "anthropic-sdk"; model: ChatModelId }
  | {
      mode: "raw";
      provider: "openrouter";
      model: string;
      params: PromptConfig["params"];
      /** OpenRouter provider-routing preferences (order/fallbacks/sort/…), passed through to the
       *  Responses request's `provider` field. Sourced from chats.metadata; undefined = default routing. */
      providerRouting: Record<string, unknown> | undefined;
    };

function isChatModelId(id: string): id is ChatModelId {
  return CHAT_MODELS.some((m) => m.id === id);
}

// Pull OpenRouter provider-routing prefs out of the chat's metadata blob, leniently — nothing
// writes this yet (no picker), so it's the seam, not a hot field. Avoids a zod dependency here
// (a plain guard satisfies both noPropertyAccessFromIndexSignature and useLiteralKeys).
function extractProviderRouting(metadata: unknown): Record<string, unknown> | undefined {
  if (metadata !== null && typeof metadata === "object" && "providerRouting" in metadata) {
    const pr = (metadata as { providerRouting: unknown }).providerRouting;
    if (pr !== null && typeof pr === "object") {
      return pr as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Resolve how this chat's next turn should run. Throws (loud invariant) on an incoherent or
 * unimplemented mode/provider combo — supported flows (create + 5D conversion) only ever produce
 * the two valid pairings, so a throw here means data corruption or a not-yet-built provider.
 */
export function resolveTurnRouting(chat: RoutableChat, config: PromptConfig): TurnRouting {
  if (chat.mode === "sdk") {
    if (chat.provider !== "anthropic-sdk") {
      throw new Error(`incoherent chat routing: mode=sdk but provider=${chat.provider}`);
    }
    // chats.model is a free string; narrow to a known sdk id or fall back to the default (guards
    // against a stale/renamed model id without a catalog round-trip on the send path).
    const model =
      chat.model !== null && isChatModelId(chat.model) ? chat.model : DEFAULT_CHAT_MODEL_ID;
    return { mode: "sdk", provider: "anthropic-sdk", model };
  }

  // raw mode. Two providers are DESIGNED (openrouter | anthropic-direct); only openrouter is built.
  if (chat.provider !== "openrouter") {
    throw new Error(`unsupported raw provider: ${chat.provider} (only openrouter is implemented)`);
  }
  return {
    mode: "raw",
    provider: "openrouter",
    model: chat.model ?? DEFAULT_RAW_MODEL_ID,
    params: config.params,
    providerRouting: extractProviderRouting(chat.metadata),
  };
}
