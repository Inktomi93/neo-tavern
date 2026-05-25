import { query } from "@anthropic-ai/claude-agent-sdk";
import { type ChatModelId, DEFAULT_CHAT_MODEL_ID } from "../../shared/models";
import { buildClaudeSdkEnv } from "../env";

// sdk-mode (YGWYG) chats run through the Claude Agent SDK, which spawns the
// official Claude Code runtime and authenticates with the host's `claude login`
// (Max subscription) — no API key, no token extraction. The options below strip
// everything that silently inflates token use, borrowed from st-claude-proxy's
// hard-won config: no built-in tools, no MCP servers, and no user settings
// (which is how plugins/hooks like superpowers sneak ~3.4k tokens into every
// request). CLAUDE.md injection is killed via buildClaudeSdkEnv().
function disciplineOptions() {
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
