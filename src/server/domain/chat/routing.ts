import {
  CHAT_MODELS,
  type ChatModelId,
  DEFAULT_CHAT_MODEL_ID,
  DEFAULT_RAW_MODEL_ID,
} from "../../../shared/models";
import type { PromptConfig } from "../../../shared/prompt-config";

// The SINGLE place api + source + model selection happens, for every chat. send()/swipe() never
// name a model or hardcode a runner — they call this once and act on the result. Adding a new
// api/source is a branch HERE, nowhere else.
//
// The split this encodes: the chat row holds the config for its NEXT turn (api/source/model);
// `messages.*` records what ACTUALLY ran (provenance). Model validity is checked at SELECTION time
// (the picker), not here on the hot send path; a stale stored id just falls back.

/** The minimal chat shape the resolver reads — structural so the unit test needs no DB. */
export interface RoutableChat {
  api: "agent-sdk" | "chat-completions" | "responses";
  source: "max-pro-sub" | "openrouter";
  model: string | null;
  metadata: unknown;
}

/**
 * What a turn runs as. Discriminated on `runner` — the thing send()/swipe() branch on, because it
 * decides the whole machinery (Agent-SDK session/seeding/resume vs a stateless OpenRouter turn
 * rebuilt from canon):
 *   • runner "agent-sdk"  serves BOTH sources — max-pro-sub (free, buildClaudeSdkEnv) and openrouter
 *     (paid Anthropic skin, buildClaudeOpenRouterEnv). `source` picks the env; the pipeline is identical.
 *   • runner "openrouter" is the @openrouter/sdk path, serving BOTH apis — chat-completions
 *     (chat.send, the broad catalog) and responses (beta.responses, OpenAI-style).
 */
export type TurnRouting =
  | {
      runner: "agent-sdk";
      api: "agent-sdk";
      source: "max-pro-sub" | "openrouter";
      model: ChatModelId;
    }
  | {
      runner: "openrouter";
      /** Which OpenRouter endpoint: chat.send (the broad catalog) vs beta.responses (OpenAI-style). */
      api: "chat-completions" | "responses";
      source: "openrouter";
      model: string;
      params: PromptConfig["params"];
      /** OpenRouter provider-routing prefs (order/fallbacks/sort/…) → the request's `provider`
       *  field. Sourced from chats.metadata; undefined = default routing. */
      providerRouting: Record<string, unknown> | undefined;
    };

function isChatModelId(id: string): id is ChatModelId {
  return CHAT_MODELS.some((m) => m.id === id);
}

// Pull OpenRouter provider-routing prefs out of the chat's metadata blob, leniently — nothing
// writes this yet (no picker), so it's the seam, not a hot field. A plain guard satisfies both
// noPropertyAccessFromIndexSignature and useLiteralKeys.
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
 * unimplemented (api, source) combo — supported flows (create + setProvider + fork) only ever
 * produce valid pairings, so a throw means data corruption or a not-yet-built api.
 */
export function resolveTurnRouting(chat: RoutableChat, config: PromptConfig): TurnRouting {
  switch (chat.api) {
    case "agent-sdk": {
      // chats.model is a free string; narrow to a known Claude id or fall back to the default
      // (guards against a stale/renamed id without a catalog round-trip on the send path). Both
      // sources use Claude tier ids — for openrouter they're remapped to OpenRouter ids by the env.
      const model =
        chat.model !== null && isChatModelId(chat.model) ? chat.model : DEFAULT_CHAT_MODEL_ID;
      return { runner: "agent-sdk", api: "agent-sdk", source: chat.source, model };
    }
    case "chat-completions":
    case "responses": {
      // Both are the @openrouter/sdk runner — chat.send (broad catalog) vs beta.responses (OpenAI
      // style). Caching is provider-aware inside the runner (Anthropic-only cache_control).
      if (chat.source !== "openrouter") {
        throw new Error(
          `incoherent routing: api=${chat.api} requires source=openrouter (got ${chat.source})`,
        );
      }
      return {
        runner: "openrouter",
        api: chat.api,
        source: "openrouter",
        model: chat.model ?? DEFAULT_RAW_MODEL_ID,
        params: config.params,
        providerRouting: extractProviderRouting(chat.metadata),
      };
    }
  }
}
