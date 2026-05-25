import process from "node:process";
import { verifyClaudeAuth } from "../src/server/providers/claude-sdk";
import { getOpenRouterClient, isOpenRouterConfigured } from "../src/server/providers/openrouter";

// Diagnostic for both chat providers. Run with `pnpm verify:claude`.
// The Claude check spawns the Agent SDK once against your `claude login` (Max
// sub); it is exactly as safe as a single `claude -p` call.
async function main(): Promise<void> {
  console.info("== Claude Agent SDK (sdk-mode · host `claude login` · no API key) ==");
  const claude = await verifyClaudeAuth();
  console.info(JSON.stringify(claude, null, 2));
  if (claude.apiKeySource === "none") {
    console.info("→ Authenticated on the Max subscription (apiKeySource=none). ✅");
  } else {
    console.info(`→ apiKeySource=${claude.apiKeySource} (not the bare subscription path).`);
  }

  console.info("\n== OpenRouter (raw-mode · non-Claude models) ==");
  if (isOpenRouterConfigured()) {
    const models = await getOpenRouterClient().models.list();
    console.info(`OpenRouter OK — ${models.data.length} models reachable. ✅`);
  } else {
    console.info("OpenRouter not configured (set OPENROUTER_API_KEY to enable raw mode).");
  }

  if (!claude.ok) {
    process.exitCode = 1;
  }
}

await main();
