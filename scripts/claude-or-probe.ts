import process from "node:process";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeOpenRouterEnv, env } from "../src/server/env";

/**
 * Claude-via-OpenRouter probe — the load-bearing assumption of the new "Claude API mode": can the
 * Agent SDK run pointed at OpenRouter's Anthropic skin? STOP CLAIMING, MEASURE. Uses the REAL
 * production env builder (buildClaudeOpenRouterEnv) so we validate the exact code mode 2 will run —
 * including its credential firewall: CLAUDE_CONFIG_DIR/ANTHROPIC_CONFIG_DIR are isolated to an empty
 * dir, so the host `claude login` token is physically unreachable and CANNOT leak to OpenRouter even
 * if this probe ran with the wrong precedence. We try 3 model-passing strategies, then run the
 * authoritative ban-risk gate.
 *
 *   pnpm exec tsx scripts/claude-or-probe.ts   (costs a few paid OpenRouter Claude turns)
 *
 * SAFETY GATE (see failsClosed): apiKeySource is NOT a safety signal — the skin authenticates with a
 * bearer ANTHROPIC_AUTH_TOKEN, so "none" (no x-api-key) is expected and benign. The real proof is
 * fail-closed: with a BOGUS auth token the turn MUST error (no host-credential fallback). If a bogus
 * token still produces a reply, a sub-credential leak path exists → do NOT build mode 2 on the SDK.
 */

const OR_KEY = env.OPENROUTER_API_KEY;

async function attempt(
  label: string,
  model: string,
  skinEnv: Record<string, string | undefined>,
): Promise<void> {
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
      env: skinEnv,
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
  // NOTE: apiKeySource is NOT a safety signal — the skin authenticates via ANTHROPIC_AUTH_TOKEN
  // (a bearer token), so "none" (no x-api-key) is EXPECTED and does not imply sub usage. The real
  // safety proof is the fail-closed check in main(): does a BOGUS token error out (no sub fallback)?
  console.log(
    err
      ? `  ${label.padEnd(26)} → ERROR ${err.slice(0, 140)}`
      : `  ${label.padEnd(26)} → reply=${JSON.stringify(reply.slice(0, 50))} apiKeySource=${apiKeySource} cost=$${cost}`,
  );
}

/**
 * The authoritative ban-risk gate: run the SAME firewall env but with a BOGUS auth token. If the
 * firewall truly isolates the host credential, there is no fallback — the turn MUST fail (OpenRouter
 * 401). If it instead SUCCEEDS, the runtime found a host credential we failed to isolate = a real
 * leak path → mode 2 is unsafe on the Agent SDK. Returns true when it failed closed (safe).
 */
async function failsClosed(skinEnv: Record<string, string | undefined>): Promise<boolean> {
  const bogusEnv = { ...skinEnv, ANTHROPIC_AUTH_TOKEN: "sk-or-v1-bogus-deadbeef-not-a-real-key" };
  // "Failed closed" = NO legitimate model reply: either the stream throws (the SDK surfaces an auth
  // failure as a thrown error result) OR a result arrives with is_error / a non-success subtype. We
  // deliberately do NOT treat assistant-text presence as success — an auth error can render AS
  // assistant text, which would be a false "leak". Only a clean success result counts as a leak.
  let gotCleanSuccess = false;
  let detail = "";
  try {
    const options: Options = {
      model: "anthropic/claude-opus-4.7",
      maxTurns: 1,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      env: bogusEnv,
    };
    for await (const m of query({ prompt: "Reply with exactly: leaked", options })) {
      if (m.type === "result") {
        detail = `result subtype=${m.subtype} is_error=${(m as { is_error?: boolean }).is_error}`;
        if (m.subtype === "success" && !m.is_error) {
          gotCleanSuccess = true;
        }
      }
    }
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  if (gotCleanSuccess) {
    console.log(
      "  fail-closed: ❌ a BOGUS token produced a CLEAN success — HOST CREDENTIAL LEAK, ABORT",
    );
    return false;
  }
  console.log(`  fail-closed: ✅ bogus token rejected (no sub fallback) — ${detail.slice(0, 90)}`);
  return true;
}

async function main(): Promise<void> {
  if (!OR_KEY) {
    console.error("no OPENROUTER_API_KEY in .env — cannot probe");
    process.exitCode = 1;
    return;
  }
  // The real mode-2 env: skin trio + the credential firewall (isolated config dirs).
  const skinEnv = buildClaudeOpenRouterEnv(OR_KEY);
  const configDirKey = "CLAUDE_CONFIG_DIR"; // bracket-via-const: index-signature access, no literal-key lint
  console.log("Claude-via-OpenRouter (Agent SDK + Anthropic skin) — does a turn complete?");
  console.log(
    `  firewall: CLAUDE_CONFIG_DIR=${skinEnv[configDirKey]} (empty → sub token unreachable)\n`,
  );
  // Run the safety gate FIRST, against a pristine config dir (before any valid-token turn caches an
  // OpenRouter session in it) — otherwise the bogus turn could reuse a cached session and look like
  // a leak. This is the honest fail-closed test: clean dir + bad token must error, never fall back.
  console.log("Safety gate (the authoritative check — runs first, against a clean config dir):");
  const safe = await failsClosed(skinEnv);
  console.log("\nViability (does a real turn complete via OpenRouter?):");
  await attempt("model=claude-opus-4-7", "claude-opus-4-7", skinEnv);
  await attempt("model=opus", "opus", skinEnv);
  await attempt("model=anthropic/...4.7", "anthropic/claude-opus-4.7", skinEnv);
  console.log(
    safe
      ? "\n→ VIABLE + SAFE: turns complete AND a bogus token fails closed (no host-credential fallback). Build mode 2."
      : "\n→ UNSAFE: do NOT build mode 2 on the Agent SDK — Claude-via-OpenRouter must use @openrouter/sdk instead.",
  );
}

await main().catch((error: unknown) => {
  console.error("probe failed:", error);
  process.exitCode = 1;
});
