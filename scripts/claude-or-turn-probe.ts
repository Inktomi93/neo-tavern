import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import { DbSessionStore } from "../src/server/domain/chat/store";
import { env } from "../src/server/env";
import { runChatTurn } from "../src/server/providers/claude-sdk";

/**
 * Mode-2 INTEGRATION probe — closes the gap the unit tests + claude-or-probe leave open: the full
 * wrapper path `runChatTurn({source:"openrouter"}) → disciplineOptions("openrouter") →
 * buildClaudeOpenRouterEnv → consumeTurnStream`, driven exactly as domain/chat.send() drives it
 * (real DbSessionStore, real resume). Also measures the SECOND unmeasured assumption: does prompt
 * caching survive OpenRouter's Anthropic skin? Turn 1 writes a cache over a padded (cache-eligible)
 * system prompt; turn 2 resumes — cacheRead > 0 proves caching passes through.
 *
 *   pnpm exec tsx scripts/claude-or-turn-probe.ts   (two paid OpenRouter Claude turns, ~$0.02)
 */

// Anthropic prompt caching has a ~1024-token minimum, so a one-line system prompt never caches even
// natively. Pad the static (cacheable) half well past that so a cache CAN form and we can observe it.
const PADDING = "The assistant is participating in a controlled caching test. ".repeat(120);
const SYSTEM_PROMPT = {
  static: `You are a terse test assistant. Answer in a few words.\n\n${PADDING}`,
  dynamic: "",
};

async function main(): Promise<void> {
  if (!env.OPENROUTER_API_KEY) {
    console.error("no OPENROUTER_API_KEY in .env — cannot probe");
    process.exitCode = 1;
    return;
  }
  const db = await createDb(":memory:");
  await runMigrations(db);
  const chatId = "or-turn-probe";
  const store = new DbSessionStore(db, chatId);

  console.log("Mode-2 turn via runChatTurn(source=openrouter) — real wrapper path\n");
  console.log("Turn 1 (cold — writes the cache):");
  const t1 = await runChatTurn({
    prompt: "Say hello in three words.",
    model: "claude-opus-4-7",
    source: "openrouter",
    sessionStore: store,
    systemPrompt: SYSTEM_PROMPT,
  });
  console.log(
    `  reply=${JSON.stringify(t1.reply.slice(0, 60))} session=${t1.sessionId.slice(0, 8)}`,
  );
  console.log(
    `  usage: in=${t1.usage.tokensIn} out=${t1.usage.tokensOut} cacheWrite=${t1.usage.cacheWriteTokens} cacheRead=${t1.usage.cacheReadTokens} cost=$${t1.usage.costUsd}`,
  );

  console.log("\nTurn 2 (resume — caching should kick in):");
  const t2 = await runChatTurn({
    prompt: "Now say goodbye in three words.",
    model: "claude-opus-4-7",
    source: "openrouter",
    sessionStore: store,
    resume: t1.sessionId,
    systemPrompt: SYSTEM_PROMPT,
  });
  console.log(`  reply=${JSON.stringify(t2.reply.slice(0, 60))}`);
  console.log(
    `  usage: in=${t2.usage.tokensIn} out=${t2.usage.tokensOut} cacheWrite=${t2.usage.cacheWriteTokens} cacheRead=${t2.usage.cacheReadTokens} cost=$${t2.usage.costUsd}`,
  );

  const worked = t1.reply.length > 0 && t2.reply.length > 0;
  const cached = t2.usage.cacheReadTokens > 0 || t1.usage.cacheWriteTokens > 0;
  console.log(
    `\n→ wrapper path: ${worked ? "✅ both turns returned replies via the skin" : "❌ a turn returned nothing"}`,
  );
  console.log(
    cached
      ? "→ caching: ✅ survives the skin (cacheWrite on turn 1 and/or cacheRead on resume)"
      : "→ caching: ⚠️ no cache tokens observed — the skin may not pass cache_control through (measure, then decide)",
  );
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("probe failed:", error);
    process.exit(1);
  });
