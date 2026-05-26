import process from "node:process";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeSdkEnv } from "../src/server/env";

/**
 * ENV-KNOB verification probe — STOP CLAIMING, MEASURE. The DISCOVER dump lists env vars the claude
 * binary REFERENCES; this proves which actually DO what their name implies, by running a turn with
 * the knob set and observing the effect (output cap, reported contextWindow, presence of thinking).
 *
 *   pnpm exec tsx scripts/env-knob-probe.ts
 * Auth: host `claude login` (Max sub). NOTE: strips the host's ambient CLAUDE_EFFORT to isolate.
 */

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-7";

interface Obs {
  outTokens: number;
  inTokens: number;
  contextWindow: number;
  maxOutput: number;
  thinkingBlocks: number;
  reply: string;
  error: string | null;
}

async function runTurn(
  prompt: string,
  knobs: Record<string, string | undefined>,
  model: string,
): Promise<Obs> {
  const obs: Obs = {
    outTokens: 0,
    inTokens: 0,
    contextWindow: 0,
    maxOutput: 0,
    thinkingBlocks: 0,
    reply: "",
    error: null,
  };
  const options = {
    model,
    maxTurns: 1,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    // Start from our subprocess env but NEUTRALIZE the ambient effort so the baseline is clean,
    // then apply the knob under test.
    env: { ...buildClaudeSdkEnv(), CLAUDE_EFFORT: undefined, ...knobs },
  } as Options;
  try {
    for await (const m of query({ prompt, options })) {
      if (m.type === "assistant") {
        for (const b of m.message.content) {
          if (b.type === "text") {
            obs.reply += b.text;
          } else if (b.type === "thinking") {
            obs.thinkingBlocks += 1;
          }
        }
      } else if (m.type === "result") {
        for (const u of Object.values(m.modelUsage)) {
          obs.outTokens += u.outputTokens;
          obs.inTokens += u.inputTokens;
          obs.contextWindow = u.contextWindow;
          obs.maxOutput = u.maxOutputTokens;
        }
      }
    }
  } catch (error) {
    obs.error = error instanceof Error ? error.message : String(error);
  }
  return obs;
}

async function main(): Promise<void> {
  const LONG = "Write a vivid 400-word fantasy scene. Do not stop early.";
  const HARD =
    "Think carefully step by step: a farmer has 17 sheep, all but 9 run away, then half the rest come back. How many now? Explain your reasoning.";

  console.log("ENV-KNOB verification (effect of each knob on a real turn)\n");

  // 1. MAX OUTPUT — does CLAUDE_CODE_MAX_OUTPUT_TOKENS cap the reply?
  const base = await runTurn(LONG, {}, HAIKU);
  const capped = await runTurn(LONG, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64" }, HAIKU);
  console.log("── CLAUDE_CODE_MAX_OUTPUT_TOKENS=64 (haiku, asked for 400 words) ──");
  console.log(`  baseline outTokens=${base.outTokens} maxOutput=${base.maxOutput}`);
  console.log(
    `  capped   outTokens=${capped.outTokens} maxOutput=${capped.maxOutput} → ${capped.outTokens < base.outTokens && capped.outTokens <= 120 ? "CAPS ✓" : "no effect ✗"}`,
  );

  // 2. MAX CONTEXT — does CLAUDE_CODE_MAX_CONTEXT_TOKENS change the reported window?
  const ctx = await runTurn("Reply 'ok'.", { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "50000" }, HAIKU);
  let ctxVerdict = "no effect ✗";
  if (ctx.contextWindow === 50000) {
    ctxVerdict = "SETS ✓";
  } else if (ctx.contextWindow !== base.contextWindow) {
    ctxVerdict = "changed≠50000 ⚠";
  }
  console.log("\n── CLAUDE_CODE_MAX_CONTEXT_TOKENS=50000 (haiku) ──");
  console.log(
    `  contextWindow reported=${ctx.contextWindow} (baseline haiku=${base.contextWindow}) → ${ctxVerdict}`,
  );

  // 3. 1M CONTEXT toggle — opus default window vs DISABLE_1M.
  const opus1m = await runTurn("Reply 'ok'.", {}, OPUS);
  const opusNo1m = await runTurn("Reply 'ok'.", { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }, OPUS);
  console.log("\n── CLAUDE_CODE_DISABLE_1M_CONTEXT (opus) ──");
  console.log(
    `  default window=${opus1m.contextWindow}  disabled window=${opusNo1m.contextWindow}`,
  );
  console.log(
    `  → ${opusNo1m.contextWindow > 0 && opusNo1m.contextWindow < opus1m.contextWindow ? "TOGGLES ✓" : "no observable change ✗"}`,
  );

  // 4. THINKING on/off — sonnet on a reasoning prompt, with vs without DISABLE_THINKING.
  const think = await runTurn(HARD, {}, SONNET);
  const noThink = await runTurn(HARD, { CLAUDE_CODE_DISABLE_THINKING: "1" }, SONNET);
  console.log("\n── CLAUDE_CODE_DISABLE_THINKING (sonnet, reasoning prompt) ──");
  console.log(`  thinking-on  thinkingBlocks=${think.thinkingBlocks} outTokens=${think.outTokens}`);
  console.log(
    `  thinking-off thinkingBlocks=${noThink.thinkingBlocks} outTokens=${noThink.outTokens} → ${noThink.thinkingBlocks < think.thinkingBlocks || (think.thinkingBlocks > 0 && noThink.thinkingBlocks === 0) ? "DISABLES ✓" : "no effect ✗"}`,
  );
  if (think.error || noThink.error) {
    console.log(`  (errors: on=${think.error} off=${noThink.error})`);
  }
}

await main().catch((error: unknown) => {
  console.error("probe failed:", error);
  process.exitCode = 1;
});
