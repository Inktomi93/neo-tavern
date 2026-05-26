import process from "node:process";
import { runRawTurn } from "../src/server/providers/openrouter";

/**
 * Raw-mode (OpenRouter Responses) live probe — STOP CLAIMING, MEASURE. Verifies:
 *   (B) a raw turn actually works end-to-end through runRawTurn with a real Claude model, and
 *   (C) whether our promptCacheKey triggers prompt caching — two calls with the SAME big static
 *       prefix; if caching works, call 2 reports cachedTokens > 0.
 *
 *   pnpm exec tsx scripts/raw-probe.ts
 * Needs OPENROUTER_API_KEY (loaded from .env). Costs 2 short paid turns. Model: Opus 4.7 via OpenRouter.
 */

const MODEL = "anthropic/claude-opus-4.7";
// A big, byte-stable system prompt (well over Anthropic's ~1024-token cache floor) so caching is
// even possible — caching only kicks in on a large enough cached prefix.
const BIG_PREFIX = `You are Aria, the warm, witty, sharp-tongued keeper of the Gilded Griffin tavern. ${"Aria remembers every regular, pours a generous measure, and never forgets a slight. She speaks in vivid, sensory prose and stays fully in character. ".repeat(60)}`;

async function call(n: number, userMsg: string): Promise<void> {
  const turn = await runRawTurn({
    model: MODEL,
    systemPrompt: { static: BIG_PREFIX, dynamic: "" },
    history: [{ role: "user", content: userMsg }],
    generation: { maxOutputTokens: 60 },
  });
  console.log(`\ncall ${n}: reply=${JSON.stringify(turn.reply.slice(0, 90))}`);
  console.log(
    `  tokensIn=${turn.usage.tokensIn} tokensOut=${turn.usage.tokensOut} cacheRead=${turn.usage.cacheReadTokens} cost=$${turn.usage.costUsd}`,
  );
}

async function main(): Promise<void> {
  console.log(`raw-probe — model=${MODEL}, static prefix ~${BIG_PREFIX.length} chars`);
  await call(1, "Greet me in one short sentence, in character.");
  await call(2, "Now bid me farewell in one short sentence, in character.");
  console.log(
    "\n→ (B) raw works if both calls returned a reply. (C) caching works if call 2 cacheRead > 0.",
  );
}

await main().catch((error: unknown) => {
  console.error("raw-probe failed:", error);
  process.exitCode = 1;
});
