import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { ChatDeltaEvent } from "../../../shared/chat-types";
import type { GenerationParams } from "../../../shared/generation";
import type { ChatModelId } from "../../../shared/models";
import type { TurnEvent } from "../turn";

// sdk-mode (YGWYG) chats run through the Claude Agent SDK, which spawns the
// official Claude Code runtime and authenticates with the host's `claude login`
// (Max subscription) — no API key, no token extraction. The options below strip
// everything that silently inflates token use, borrowed from st-claude-proxy's
// hard-won config: no built-in tools, no MCP servers, and no user settings
// (which is how plugins/hooks like superpowers sneak ~3.4k tokens into every
// request). CLAUDE.md injection is killed via buildClaudeSdkEnv().
// Exported so the leak-prevention contract is locked by tests (see the proxy
// painpoints in claude-sdk.test.ts).
// `source` picks the credential the spawned runtime authenticates with — the ONLY difference
// between the two Agent-SDK paths (the pipeline, leak-discipline, and generation knobs are
// identical): "max-pro-sub" → the host `claude login` (free); "openrouter" → OpenRouter's Anthropic
// skin (paid, credentials firewalled to an isolated config dir — see buildClaudeOpenRouterEnv).
export type ClaudeSource = "max-pro-sub" | "openrouter";
export interface ClaudeAuthResult {
  /** True when the query completed without an error result. */
  ok: boolean;
  /** From the SDK init message: "none" means the host `claude login` (sub) was used, not an API key. */
  apiKeySource: string;
  model: string;
  reply: string;
  /** Metered-equivalent cost; on a flat-rate Max sub this is allowance, not dollars. */
  costUsd: number;
}

/**
 * One-shot auth check: sends a trivial prompt and reports which credential the
 * SDK used. Drives `pnpm verify:claude`. Defaults to the cheapest tier.
 */
export interface ChatTurnParams {
  prompt: string;
  model: ChatModelId;
  /** Which credential the runtime authenticates with (the only difference between the two
   *  Agent-SDK paths). Defaults to the free Max sub. */
  source?: ClaudeSource;
  /** Resume an existing session; omit for the first turn of a new chat. */
  resume?: string;
  /** Our DB-backed SessionStore — the SDK loads from it to resume and mirrors new frames into it. */
  sessionStore: SessionStore;
  /** Assembled character/system prompt. `static` becomes the cached prefix; `dynamic` (if any)
   *  goes after SYSTEM_PROMPT_DYNAMIC_BOUNDARY so it re-evaluates per turn without busting the
   *  cached prefix (see docs/sdk-notes.md). Built by domain/chat via shared/prompt-assemble. */
  systemPrompt?: { static: string; dynamic: string };
  /** The unified generation knobs (shared/generation.ts). The runner translates them to typed SDK
   *  Options (thinking/effort/maxBudgetUsd) + env (maxOutputTokens, thinking-disable). temperature/
   *  topP are no-ops here (the SDK owns sampling). undefined = the owner defaults. */
  generation?: GenerationParams | undefined;
  /** Optional live event sink (compaction/retry/rate-limit/...). The streaming-UI seam:
   *  a future SSE subscription forwards these; default undefined = collect-and-return only.
   *  consumer until the chat UI lands; see docs/sdk-notes.md.) */
  onEvent?: (event: TurnEvent) => void;
  /** Streaming token-delta callback — discriminated by kind (text|reasoning).
   *  The Claude agent-sdk path always emits kind="text" (CoT is internal to the SDK). */
  onDelta?: (event: ChatDeltaEvent) => void;
}

/**
 * One stateless YGWYG turn (the resume-per-message model). Spawns the runtime,
 * resumes from our store, consumes the FULL SDK message stream — classifying
 * compaction, retries, rate-limits, auth, and error results, not just the reply —
 * and returns the text + session id + per-turn usage + the structured events.
 * Throws {@link TurnError} on any failure result so the caller can surface a
 * typed, provider-agnostic reason. Injected into `domain/chat` as a seam so the
 * turn logic is testable with a fake (no sub queries in `pnpm check`).
 */
// Translate the unified GenerationParams into the agent-sdk's native surface: typed Options
// (thinking/effort/maxBudgetUsd) for the things the SDK types directly, plus env overrides for the
// rest (output cap; thinking-disable, the owner default). effort/thinking only apply when thinking
// is on (the SDK ignores effort otherwise). temperature/topP have no agent-sdk knob → dropped.
export interface TurnStreamContext {
  model: ChatModelId;
  resumed: boolean;
  onEvent?: (event: TurnEvent) => void;
  onDelta?: (event: ChatDeltaEvent) => void;
}
