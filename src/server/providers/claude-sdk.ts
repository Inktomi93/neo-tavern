import { query, type SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { type ChatModelId, DEFAULT_CHAT_MODEL_ID } from "../../shared/models";
import { buildClaudeSdkEnv } from "../env";
import { getLog } from "../observability/logger";

// sdk-mode (YGWYG) chats run through the Claude Agent SDK, which spawns the
// official Claude Code runtime and authenticates with the host's `claude login`
// (Max subscription) — no API key, no token extraction. The options below strip
// everything that silently inflates token use, borrowed from st-claude-proxy's
// hard-won config: no built-in tools, no MCP servers, and no user settings
// (which is how plugins/hooks like superpowers sneak ~3.4k tokens into every
// request). CLAUDE.md injection is killed via buildClaudeSdkEnv().
// Exported so the leak-prevention contract is locked by tests (see the proxy
// painpoints in claude-sdk.test.ts).
export function disciplineOptions() {
  return {
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    env: buildClaudeSdkEnv(),
  };
}

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
export async function verifyClaudeAuth(
  model: ChatModelId = DEFAULT_CHAT_MODEL_ID,
): Promise<ClaudeAuthResult> {
  const stream = query({
    prompt: "Reply with exactly the two characters: ok",
    options: { ...disciplineOptions(), model, maxTurns: 1 },
  });

  let apiKeySource = "unknown";
  let reply = "";
  let costUsd = 0;
  let ok = false;

  for await (const message of stream) {
    if (message.type === "system" && message.subtype === "init") {
      apiKeySource = message.apiKeySource;
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          reply += block.text;
        }
      }
    } else if (message.type === "result") {
      ok = !message.is_error;
      costUsd = message.total_cost_usd;
    }
  }

  return { ok, apiKeySource, model, reply: reply.trim(), costUsd };
}

export interface ChatTurnUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface ChatTurnResult {
  reply: string;
  /** result.session_id — persist on the chat row so the next turn resumes it. */
  sessionId: string;
  stopReason: string | null;
  usage: ChatTurnUsage;
}

export interface ChatTurnParams {
  prompt: string;
  model: ChatModelId;
  /** Resume an existing session; omit for the first turn of a new chat. */
  resume?: string;
  /** Our DB-backed SessionStore — the SDK loads from it to resume and mirrors new frames into it. */
  sessionStore: SessionStore;
}

/**
 * One stateless YGWYG turn (the resume-per-message model). Spawns the runtime,
 * resumes from our store, streams the reply, and returns the text + session id +
 * per-turn usage (stateless → `result.usage` is per-turn, a direct copy). The
 * `domain/chat` service depends on this as an injectable seam so the turn logic is
 * testable with a fake (no sub queries in `pnpm check`).
 */
export async function runChatTurn(params: ChatTurnParams): Promise<ChatTurnResult> {
  const startedAt = Date.now();
  const stream = query({
    prompt: params.prompt,
    options: {
      ...disciplineOptions(),
      model: params.model,
      maxTurns: 1,
      sessionStore: params.sessionStore,
      ...(params.resume ? { resume: params.resume } : {}),
    },
  });

  let reply = "";
  let sessionId = "";
  let stopReason: string | null = null;
  const usage: ChatTurnUsage = {
    model: params.model,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };

  try {
    for await (const message of stream) {
      if ("session_id" in message && typeof message.session_id === "string") {
        sessionId = message.session_id;
      }
      if (message.type === "assistant") {
        stopReason = message.message.stop_reason ?? stopReason;
        for (const block of message.message.content) {
          if (block.type === "text") {
            reply += block.text;
          }
        }
      } else if (message.type === "result") {
        for (const modelUsage of Object.values(message.modelUsage)) {
          usage.tokensIn += modelUsage.inputTokens;
          usage.tokensOut += modelUsage.outputTokens;
          usage.cacheReadTokens += modelUsage.cacheReadInputTokens;
          usage.cacheWriteTokens += modelUsage.cacheCreationInputTokens;
          usage.costUsd += modelUsage.costUSD;
        }
      }
    }
  } catch (error) {
    // The model boundary — observe failures (rate-limit/SDK errors) without swallowing them.
    getLog().error(
      {
        model: params.model,
        resumed: Boolean(params.resume),
        err: error instanceof Error ? error.message : String(error),
      },
      "claude: turn failed",
    );
    throw error;
  }

  // Metadata only — NEVER the prompt/reply (RP content lives in the DB). Cost/tokens/latency
  // are the analytics-grade signals you want curl-able per turn (also stored on the message).
  getLog().info(
    {
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: usage.costUsd,
      stopReason,
      resumed: Boolean(params.resume),
      durationMs: Date.now() - startedAt,
    },
    "claude: turn complete",
  );
  return { reply: reply.trim(), sessionId, stopReason, usage };
}
