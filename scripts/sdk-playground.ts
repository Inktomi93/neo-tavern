import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeSdkEnv } from "../src/server/env";

/**
 * Agent SDK playground — open the black box. Fires ONE query with maximum
 * observability and dumps every message the SDK emits, in order, with timing,
 * so you can SEE the lifecycle instead of guessing. Toggle knobs via env vars.
 *
 *   pnpm sdk:play                      # lean default (haiku, no tools/mcp/settings)
 *   PROMPT="..." MODEL=claude-opus-4-7 pnpm sdk:play
 *   DEBUG=1 pnpm sdk:play              # injection audit: hooks/plugins loaded + API request sources (via debugFile)
 *   TOOLS=1 pnpm sdk:play              # let it use built-in tools (watch PreToolUse hooks fire)
 *   MCP=1 SETTINGS=1 pnpm sdk:play     # load YOUR ~/.claude mcp servers + plugins/hooks
 *   FULL=1 pnpm sdk:play               # full message JSON instead of truncated
 *   NOSTREAM=1 pnpm sdk:play           # disable partial (streaming) messages
 *
 * Auth: host `claude login` (Max sub) — same as the real provider, no API key.
 */

const getEnv = (key: string): string | undefined => process.env[key];
const flag = (key: string): boolean => {
  const v = getEnv(key);
  return v === "1" || v === "true";
};

const PROMPT = getEnv("PROMPT") ?? "In one short sentence, what are you? Then stop.";
const MODEL = getEnv("MODEL") ?? "claude-haiku-4-5-20251001";
const MAX_TURNS = Number(getEnv("MAXTURNS") ?? "1") || 1;
const FULL = flag("FULL");
const DEBUG = flag("DEBUG");
const DEBUG_FILE = join(tmpdir(), "neo-tavern-sdk-play.debug.log");

const options: Options = {
  model: MODEL,
  maxTurns: MAX_TURNS,
  env: buildClaudeSdkEnv(),
  includePartialMessages: !flag("NOSTREAM"),
  includeHookEvents: true,
  // Knobs you can flip to explore. Lean by default (like the real provider).
  ...(flag("TOOLS") ? {} : { tools: [] as string[] }),
  ...(flag("MCP") ? {} : { mcpServers: {}, strictMcpConfig: true }),
  ...(flag("SETTINGS") ? {} : { settingSources: [] }),
  // debugFile (the channel that actually works) drives the injection audit below.
  ...(DEBUG ? { debugFile: DEBUG_FILE } : {}),
};

/**
 * Injection audit — reads the SDK debug log to surface what was actually loaded
 * into the conversation (the proxy's superpowers-plugin-leak class of bug),
 * without asking the model. Pair with the input-token canary printed at the end.
 */
function injectionAudit(): void {
  let log = "";
  try {
    log = readFileSync(DEBUG_FILE, "utf8");
  } catch {
    console.log("\n(no debug log — run with DEBUG=1)");
    return;
  }
  const strip = (line: string): string => line.replace(/^.*\]\s/, "");
  const lines = log.split("\n");
  console.log("\n── INJECTION AUDIT (from the SDK debug log) ──");
  for (const line of lines) {
    if (
      /Registered \d+ hooks|plugin skills loaded|plugin commands loaded|Found \d+ plugins|installed plugins/.test(
        line,
      )
    ) {
      console.log(`  ${strip(line)}`);
    }
  }
  const requests = lines.filter((line) => line.includes("[API REQUEST]")).map(strip);
  console.log(`  API requests (${requests.length}):`);
  for (const request of requests) {
    console.log(`    ${request.slice(0, 130)}`);
  }
  console.log(`  full log: ${DEBUG_FILE}`);
}

function compact(message: unknown): string {
  const json = JSON.stringify(message);
  return FULL || json.length <= 200 ? json : `${json.slice(0, 200)}…`;
}

async function main(): Promise<void> {
  console.log("Agent SDK playground");
  console.log(`  model=${MODEL} maxTurns=${MAX_TURNS} stream=${!flag("NOSTREAM")} debug=${DEBUG}`);
  console.log(`  tools=${flag("TOOLS")} mcp=${flag("MCP")} settings=${flag("SETTINGS")}`);
  console.log(`  prompt=${JSON.stringify(PROMPT)}\n`);

  const start = performance.now();
  let count = 0;
  let reply = "";
  let inputTokens = 0;

  for await (const message of query({ prompt: PROMPT, options })) {
    count += 1;
    const dt = Math.round(performance.now() - start);
    const tag = "subtype" in message ? `${message.type}/${String(message.subtype)}` : message.type;

    if (message.type === "system" && message.subtype === "init") {
      // The init message is the SDK's full self-reported config — model, tools,
      // mcp_servers, slash_commands, skills, permissionMode, apiKeySource, cwd…
      console.log(`[${count}] ${tag} (+${dt}ms) — the SDK's self-reported config:`);
      console.log(JSON.stringify(message, null, 2));
    } else if (message.type === "result") {
      inputTokens = Object.values(message.modelUsage).reduce(
        (sum, usage) => sum + usage.inputTokens,
        0,
      );
      console.log(`[${count}] ${tag} (+${dt}ms) — RESULT (usage / cost / turns):`);
      console.log(JSON.stringify(message, null, 2));
    } else {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            reply += block.text;
          }
        }
      }
      console.log(`[${count}] ${tag} (+${dt}ms) ${compact(message)}`);
    }
  }

  console.log(`\n${count} messages · reply: ${JSON.stringify(reply.trim())}`);
  // The canary: a lean turn is ~160 input tokens. Inflation = something was
  // injected into the conversation (plugins/hooks/CLAUDE.md/settings leaking in).
  console.log(`INPUT TOKENS: ${inputTokens}  (lean baseline ~160; inflation = injection)`);
  if (DEBUG) {
    injectionAudit();
  }
}

await main().catch((error: unknown) => {
  console.error("playground failed:", error);
  process.exitCode = 1;
});
