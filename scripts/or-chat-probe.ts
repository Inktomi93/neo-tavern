import process from "node:process";
import { env } from "../src/server/env";
import { type RawTurnParams, runChatCompletionTurn } from "../src/server/providers/openrouter";

/**
 * Chat-Completions runner probe — validates the REAL request shape of runChatCompletionTurn (the
 * field names maxCompletionTokens/cacheControl/provider, the ChatResultView → ChatTurnResult
 * mapping) against live OpenRouter, which the unit tests (fakes) can't. Two checks:
 *   1. a NON-Anthropic model returns a reply + inline cost/usage (no cache_control sent — auto-cache)
 *   2. an Anthropic model over a padded (cache-eligible) prompt: turn 1 cacheWrite, turn 2 cacheRead
 *      → proves provider-aware caching works THROUGH chat completions, not just sdk-mode.
 *
 *   pnpm exec tsx scripts/or-chat-probe.ts   (a few cheap paid OpenRouter turns, ~$0.02)
 */

const NON_ANTHROPIC = process.env["OR_MODEL"] ?? "openai/gpt-4o-mini";
const ANTHROPIC = "anthropic/claude-sonnet-4.6";
// Pad past the prompt-cache minimum (~1024 tok) so a cache can form. The runner pins the Anthropic
// provider for Anthropic models so cache_control is actually honored (measured: an unpinned route
// can land on an endpoint that ignores it).
const PADDING = "This assistant participates in a controlled caching test. ".repeat(320);

function turn(model: string, system: string, userText: string): RawTurnParams {
  return {
    model,
    systemPrompt: { static: system, dynamic: "" },
    history: [{ role: "user", content: userText }],
    generation: { temperature: 0.7, maxOutputTokens: 64 },
  };
}

async function main(): Promise<void> {
  if (!env.OPENROUTER_API_KEY) {
    console.error("no OPENROUTER_API_KEY in .env — cannot probe");
    process.exitCode = 1;
    return;
  }

  console.log(`1) non-Anthropic (${NON_ANTHROPIC}) — reply + inline cost, NO cache_control sent:`);
  const a = await runChatCompletionTurn(
    turn(NON_ANTHROPIC, "You are terse. Answer briefly.", "Say hi in 3 words."),
  );
  console.log(
    `   reply=${JSON.stringify(a.reply.slice(0, 50))} in=${a.usage.tokensIn} out=${a.usage.tokensOut} cacheRead=${a.usage.cacheReadTokens} cost=$${a.usage.costUsd}`,
  );

  console.log(
    `\n2) Anthropic (${ANTHROPIC}) — cache_control directive, padded prompt over two turns:`,
  );
  const sys = `You are terse. Answer briefly.\n\n${PADDING}`;
  const b1 = await runChatCompletionTurn(turn(ANTHROPIC, sys, "Say hi in 3 words."));
  console.log(
    `   turn 1: reply=${JSON.stringify(b1.reply.slice(0, 40))} cacheWrite=${b1.usage.cacheWriteTokens} cacheRead=${b1.usage.cacheReadTokens} cost=$${b1.usage.costUsd}`,
  );
  const b2 = await runChatCompletionTurn(turn(ANTHROPIC, sys, "Say bye in 3 words."));
  console.log(
    `   turn 2: reply=${JSON.stringify(b2.reply.slice(0, 40))} cacheWrite=${b2.usage.cacheWriteTokens} cacheRead=${b2.usage.cacheReadTokens} cost=$${b2.usage.costUsd}`,
  );

  console.log(
    `\n→ runner works: ${a.reply.length > 0 && b1.reply.length > 0 ? "✅ both models returned replies via chat.send" : "❌ a model returned nothing"}`,
  );
  console.log(
    b2.usage.cacheReadTokens > 0 || b1.usage.cacheWriteTokens > 0
      ? "→ Anthropic caching via chat completions: ✅ observed cache tokens"
      : "→ Anthropic caching: ⚠️ no cache tokens (may need a larger prompt / different ttl — measure)",
  );
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("probe failed:", error);
    process.exit(1);
  });
