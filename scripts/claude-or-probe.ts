import process from "node:process";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../src/server/env";

/**
 * Claude-via-OpenRouter probe — the load-bearing assumption of the new "Claude API mode": can the
 * Agent SDK run pointed at OpenRouter's Anthropic skin? STOP CLAIMING, MEASURE. Sets the env the
 * OpenRouter Claude Code integration doc prescribes (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN +
 * blank ANTHROPIC_API_KEY) and tries a turn through a Claude model, reporting which model-passing
 * strategy works. If a turn completes, mode 2 reuses our ENTIRE Agent-SDK pipeline for free.
 *
 *   pnpm exec tsx scripts/claude-or-probe.ts   (costs a few paid OpenRouter Claude turns)
 */

const OR_KEY = env.OPENROUTER_API_KEY;

function orEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    // The Anthropic-skin trio (the doc: ANTHROPIC_API_KEY MUST be empty string, not unset).
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: OR_KEY,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "true",
    // Map the tiers to OpenRouter Claude ids (the doc's model-config approach).
    ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.7",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-4.6",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5",
  };
}

async function attempt(label: string, model: string): Promise<void> {
  let reply = "";
  let apiKeySource = "?";
  let cost = 0;
  let err: string | null = null;
  try {
    const options: Options = {
      model,
      maxTurns: 1,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      env: orEnv(),
    };
    for await (const m of query({ prompt: "Reply with exactly: hello from openrouter", options })) {
      if (m.type === "system" && m.subtype === "init") {
        apiKeySource = m.apiKeySource;
      } else if (m.type === "assistant") {
        for (const b of m.message.content) {
          if (b.type === "text") {
            reply += b.text;
          }
        }
      } else if (m.type === "result") {
        cost = m.total_cost_usd;
      }
    }
  } catch (error) {
    err = error instanceof Error ? error.message : String(error);
  }
  console.log(
    err
      ? `  ${label.padEnd(26)} → ERROR ${err.slice(0, 140)}`
      : `  ${label.padEnd(26)} → reply=${JSON.stringify(reply.slice(0, 50))} apiKeySource=${apiKeySource} cost=$${cost}`,
  );
}

async function main(): Promise<void> {
  if (!OR_KEY) {
    console.error("no OPENROUTER_API_KEY in .env — cannot probe");
    process.exitCode = 1;
    return;
  }
  console.log("Claude-via-OpenRouter (Agent SDK + Anthropic skin) — does a turn complete?\n");
  await attempt("model=claude-opus-4-7", "claude-opus-4-7");
  await attempt("model=opus", "opus");
  await attempt("model=anthropic/...4.7", "anthropic/claude-opus-4.7");
  console.log(
    "\n→ mode 2 is viable if ANY strategy returns a reply (cost>0 = it billed OpenRouter).",
  );
}

await main().catch((error: unknown) => {
  console.error("probe failed:", error);
  process.exitCode = 1;
});
