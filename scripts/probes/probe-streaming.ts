/**
 * Streaming probe — fires ONE short turn through all three streaming paths and
 * dumps EVERY raw event/chunk so we know exactly what fields come back for text,
 * reasoning, usage, errors, and finish reasons.
 *
 *   pnpm tsx scripts/probes/probe-streaming.ts
 *
 * Modes (env vars):
 *   PROBE=sdk          Agent SDK streaming (claude sub / Max)
 *   PROBE=chat         OpenRouter chat.send streaming
 *   PROBE=responses    OpenRouter beta.responses streaming
 *   (default = all three, sequentially)
 *
 *   MODEL=<id>         Override the model (e.g. "anthropic/claude-3-7-sonnet")
 *   PROMPT="..."       Override the prompt
 *   THINK=1            Add reasoning effort (sonnet-3-7 or o3-mini recommended)
 *   FULL=1             Print full JSON of every event (default = truncated at 400 chars)
 */

// @ts-nocheck
import process from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeOpenRouterEnv, buildClaudeSdkEnv } from "../../src/server/env.js";
import { getOpenRouterClient } from "../../src/server/providers/openrouter.js";

const flag = (k: string) => process.env[k] === "1" || process.env[k] === "true";
const PROBE = process.env["PROBE"] ?? "all";
const PROMPT = process.env["PROMPT"] ?? "Say exactly: 'hello from the stream'. Nothing else.";
const MODEL_OVERRIDE = process.env["MODEL"];
const FULL = flag("FULL");
const THINK = flag("THINK");
// SOURCE controls which Claude Agent SDK credential path to use:
//   SOURCE=max   (default) → host `claude login` (Max sub, apiKeySource="none")
//   SOURCE=or              → OpenRouter's Anthropic skin (apiKeySource will be an OR key)
// Only affects the SDK probe; the chat/responses probes always use OpenRouter.
const SDK_SOURCE: "max" | "or" = process.env["SOURCE"] === "or" ? "or" : "max";

const OPENROUTER_KEY = process.env["OPENROUTER_API_KEY"] ?? "";

function buildSdkEnv(): Record<string, string | undefined> {
  if (SDK_SOURCE === "or") {
    if (!OPENROUTER_KEY) {
      console.error("SOURCE=or requires OPENROUTER_API_KEY to be set.");
      process.exit(1);
    }
    return buildClaudeOpenRouterEnv(OPENROUTER_KEY);
  }
  return buildClaudeSdkEnv();
}

const truncate = (s: string, max = 400) =>
  FULL || s.length <= max ? s : `${s.slice(0, max)}… [+${s.length - max} chars]`;

const dump = (label: string, obj: unknown) => {
  console.log(`  ${label}:`);
  console.log(truncate(`    ${JSON.stringify(obj, null, 2).replace(/\n/g, "\n    ")}`));
};

const sep = (title: string) => {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
};

// ── Agent SDK (claude subscription) ─────────────────────────────────────────

async function probeAgentSdk(): Promise<void> {
  sep(`AGENT SDK — includePartialMessages=true  source=${SDK_SOURCE}`);
  const model = MODEL_OVERRIDE ?? "claude-haiku-4-5-20251001";
  console.log(`  model=${model}  thinking=${THINK}  source=${SDK_SOURCE}`);
  console.log(`  prompt=${JSON.stringify(PROMPT)}\n`);

  let eventIdx = 0;
  // const start = Date.now(); // Removed unused variable

  for await (const message of query({
    prompt: PROMPT,
    options: {
      model,
      maxTurns: 1,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      env: buildSdkEnv(),
      includePartialMessages: true,
      ...(THINK ? { thinking: { type: "enabled", budgetTokens: 2000 } } : {}),
    },
  })) {
    eventIdx += 1;
    // const _tag = "subtype" in message ? `${message.type}/${String(message.subtype)}` : message.type;

    if (message.type === "system" && message.subtype === "init") {
      // Key fields from init: apiKeySource tells us which auth path fired.
      //   "none"          → Max sub (claude login)
      //   "openrouter-.." → OpenRouter Anthropic skin
      const init = message as {
        apiKeySource?: unknown;
        model?: unknown;
        claude_code_version?: unknown;
      };
      console.log(
        `  [sdk #${eventIdx}] system/init  apiKeySource=${init.apiKeySource}  model=${init.model}  claudeCodeVersion=${init.claude_code_version}`,
      );
      if (FULL) dump("full init", message);
    } else if (message.type === "stream_event") {
      const ev = (
        message as { event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } } }
      ).event;
      console.log(`    event.type = ${ev?.type}`);
      if (ev?.type === "content_block_delta") {
        const delta = ev.delta;
        console.log(`    delta.type = ${delta?.type}`);
        if (delta?.type === "text_delta") {
          process.stdout.write(`    text chunk: ${JSON.stringify(ev.delta.text)}\n`);
        } else if (ev.delta?.type === "thinking_delta") {
          process.stdout.write(
            `    thinking chunk: ${JSON.stringify(ev.delta.thinking?.slice(0, 60))}…\n`,
          );
        }
      } else if (ev?.type === "content_block_start") {
        dump("content_block_start", ev.content_block);
      } else if (ev?.type === "message_start") {
        dump("message_start.message (usage + model)", {
          model: ev.message?.model,
          usage: ev.message?.usage,
        });
      } else if (ev?.type === "message_delta") {
        dump("message_delta (stop_reason + usage)", {
          stop_reason: ev.delta?.stop_reason,
          usage: ev.usage,
        });
      } else {
        dump("full stream_event.event", ev);
      }
    } else if (message.type === "assistant") {
      // The completed assistant message (appears AFTER all stream_events for that turn)
      type Block = { type: string; text?: string; thinking?: string };
      const text = (message.message.content as Block[])
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .join("");
      const thinking = (message.message.content as Block[])
        .filter((b) => b.type === "thinking")
        .map((b) => (b.thinking as string).slice(0, 80))
        .join("");
      console.log(`    → assembled reply: ${JSON.stringify(text.trim().slice(0, 120))}`);
      if (thinking) console.log(`    → thinking snippet: ${JSON.stringify(thinking)}…`);
    } else if (message.type === "result") {
      dump("result (usage / cost / duration)", {
        subtype: message.subtype,
        duration_ms: message.duration_ms,
        duration_api_ms: message.duration_api_ms,
        numTurns: message.num_turns,
        modelUsage: message.modelUsage,
      });
    } else {
      // All other types: system/init, user, status, rate_limit, auth_status, etc.
      dump("full message", message);
    }
  }

  console.log(`\n  sdk probe done — ${eventIdx} events`);
}

// ── OpenRouter chat.send (streaming) ────────────────────────────────────────

async function probeChatStream(): Promise<void> {
  sep("OPENROUTER chat.send — stream: true");
  const model = MODEL_OVERRIDE ?? "openai/gpt-4o-mini";
  console.log(`  model=${model}  thinking=${THINK}`);
  console.log(`  prompt=${JSON.stringify(PROMPT)}\n`);

  const client = getOpenRouterClient();
  const request: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: PROMPT }],
    stream: true,
    ...(THINK ? { reasoning: { effort: "low" } } : {}),
  };

  let chunkIdx = 0;
  let assembledText = "";
  let assembledReasoning = "";
  let lastUsage: unknown = null;
  let lastFinishReason: string | null = null;
  const start = Date.now();

  const stream = await (
    client.chat.send as unknown as (req: {
      chatRequest: Record<string, unknown>;
    }) => Promise<AsyncIterable<Record<string, unknown>>>
  )({ chatRequest: request });

  for await (const chunk of stream) {
    chunkIdx += 1;
    const dt = Date.now() - start;

    // In-band error (OpenRouter embeds these in the stream instead of throwing)
    if (chunk.error != null) {
      console.log(`[chat #${chunkIdx}] +${dt}ms  IN-BAND ERROR:`);
      dump("chunk.error", chunk.error);
      continue;
    }

    const delta = chunk.choices?.[0]?.delta;
    const finishReason = chunk.choices?.[0]?.finishReason ?? chunk.choices?.[0]?.finish_reason;
    const hasText = typeof delta?.content === "string" && delta.content.length > 0;
    const hasReasoning = typeof delta?.reasoning === "string" && delta.reasoning.length > 0;
    const hasUsage = chunk.usage != null;

    if (hasText) {
      assembledText += delta.content;
      process.stdout.write(
        `[chat #${chunkIdx}] +${dt}ms  TEXT: ${JSON.stringify(delta.content)}\n`,
      );
    } else if (hasReasoning) {
      assembledReasoning += delta.reasoning;
      process.stdout.write(
        `[chat #${chunkIdx}] +${dt}ms  REASONING: ${JSON.stringify((delta.reasoning as string).slice(0, 80))}\n`,
      );
    } else if (finishReason) {
      lastFinishReason = finishReason;
      console.log(`[chat #${chunkIdx}] +${dt}ms  SENTINEL  finishReason=${finishReason}`);
      if (hasUsage) {
        lastUsage = chunk.usage;
        dump("usage (final sentinel)", chunk.usage);
      }
    } else if (hasUsage) {
      lastUsage = chunk.usage;
      console.log(`[chat #${chunkIdx}] +${dt}ms  USAGE-ONLY chunk:`);
      dump("usage", chunk.usage);
    } else {
      // Anything we don't classify — show in full so nothing is hidden
      console.log(`[chat #${chunkIdx}] +${dt}ms  UNCLASSIFIED:`);
      dump("full chunk", chunk);
    }
  }

  console.log(`\n  chat probe done — ${chunkIdx} chunks`);
  console.log(`  assembled text:      ${JSON.stringify(assembledText.trim().slice(0, 120))}`);
  if (assembledReasoning)
    console.log(`  assembled reasoning: ${JSON.stringify(assembledReasoning.slice(0, 120))}…`);
  console.log(`  finish reason: ${lastFinishReason}`);
  console.log(`  final usage:   ${JSON.stringify(lastUsage)}`);
  console.log("\n  ── FIELD MAP (what we read from ChatStreamChunk) ──");
  console.log("    text    → chunk.choices[0].delta.content   (string | null)");
  console.log("    reason  → chunk.choices[0].delta.reasoning  (string | null, CoT models)");
  console.log("    stop    → chunk.choices[0].finishReason     (set on sentinel)");
  console.log(
    "    usage   → chunk.usage                       (ChatUsage, set on sentinel or trailing)",
  );
  console.log(
    "    error   → chunk.error                       ({ code: number, message: string })",
  );
}

// ── OpenRouter beta.responses.send (streaming) ──────────────────────────────

async function probeResponsesStream(): Promise<void> {
  sep("OPENROUTER beta.responses.send — stream: true");
  const model = MODEL_OVERRIDE ?? "openai/gpt-4o-mini";
  console.log(`  model=${model}  thinking=${THINK}`);
  console.log(`  prompt=${JSON.stringify(PROMPT)}\n`);

  const client = getOpenRouterClient();
  const request: Record<string, unknown> = {
    model,
    input: [{ role: "user", content: PROMPT }],
    stream: true,
    ...(THINK ? { reasoning: { effort: "low", summary: "auto" } } : {}),
  };

  let eventIdx = 0;
  let assembledText = "";
  const start = Date.now();

  const stream = await (
    client.beta.responses.send as unknown as (req: {
      responsesRequest: Record<string, unknown>;
    }) => Promise<AsyncIterable<Record<string, unknown>>>
  )({ responsesRequest: request });

  for await (const event of stream) {
    eventIdx += 1;
    const dt = Date.now() - start;
    const type: string = event.type ?? "unknown";

    switch (type) {
      case "response.output_text.delta":
        assembledText += event.delta ?? "";
        process.stdout.write(
          `[resp #${eventIdx}] +${dt}ms  TEXT_DELTA: ${JSON.stringify(event.delta)}\n`,
        );
        break;

      case "response.reasoning_text.delta":
        process.stdout.write(
          `[resp #${eventIdx}] +${dt}ms  REASONING_DELTA: ${JSON.stringify((event.delta as string).slice(0, 80))}\n`,
        );
        break;

      case "response.reasoning_summary_text.delta":
        process.stdout.write(
          `[resp #${eventIdx}] +${dt}ms  REASONING_SUMMARY_DELTA: ${JSON.stringify((event.delta as string).slice(0, 80))}\n`,
        );
        break;

      case "response.completed":
      case "response.incomplete": {
        const resp = event.response;
        console.log(`[resp #${eventIdx}] +${dt}ms  TERMINAL  type=${type}`);
        dump("response.status", resp?.status);
        dump("response.incompleteDetails", resp?.incompleteDetails);
        dump("response.usage", resp?.usage);
        dump("response.error", resp?.error);
        break;
      }

      case "response.failed": {
        const resp = event.response;
        console.log(`[resp #${eventIdx}] +${dt}ms  FAILED`);
        dump("response.error", resp?.error);
        dump("response.status", resp?.status);
        break;
      }

      case "error":
        console.log(`[resp #${eventIdx}] +${dt}ms  IN-BAND ERROR:`);
        dump("event (code+message)", { code: event.code, message: event.message });
        break;

      // Lifecycle events — log the type and key fields, not the whole blob
      case "response.created":
      case "response.in_progress":
        console.log(`[resp #${eventIdx}] +${dt}ms  LIFECYCLE  type=${type}`);
        break;

      case "response.output_item.added":
      case "response.output_item.done":
        console.log(`[resp #${eventIdx}] +${dt}ms  OUTPUT_ITEM  type=${type}`);
        dump("item", { type: event.item?.type, id: event.item?.id });
        break;

      case "response.content_part.done": {
        console.log(`[resp #${eventIdx}] +${dt}ms  CONTENT_PART  type=${type}`);
        const ev = event as { part?: { type?: unknown } };
        dump("part", { type: ev.part?.type });
        break;
      }

      case "response.output_text.done":
      case "response.reasoning_text.done":
      case "response.reasoning_summary_text.done": {
        console.log(`[resp #${eventIdx}] +${dt}ms  DONE  type=${type}`);
        const e = event as { type?: unknown; text?: unknown };
        if (typeof e.type === "string") {
          dump("event", e.type);
        }
        if (typeof e.text === "string") dump("text", e.text.slice(0, 120));
        break;
      }

      default:
        // Catch-all: show everything so nothing is silently swallowed
        console.log(`[resp #${eventIdx}] +${dt}ms  UNKNOWN  type=${type}`);
        dump("full event", event);
        break;
    }
  }

  console.log(`\n  responses probe done — ${eventIdx} events`);
  console.log(`  assembled text: ${JSON.stringify(assembledText.trim().slice(0, 120))}`);
  console.log("\n  ── FIELD MAP (what we read from StreamEvents) ──");
  console.log("    text    → event.delta               (on response.output_text.delta)");
  console.log("    reason  → event.delta               (on response.reasoning_text.delta)");
  console.log("    summary → event.delta               (on response.reasoning_summary_text.delta)");
  console.log("    stop    → event.response.status      (on response.completed / .incomplete)");
  console.log("    usage   → event.response.usage       (on response.completed / .incomplete)");
  console.log("    error   → event.response.error       (on response.failed)");
  console.log("    error   → event.code + event.message (on 'error' SSE event)");
}

// ── Entry point ─────────────────────────────────────────────────────────────

const probes: Record<string, () => Promise<void>> = {
  sdk: probeAgentSdk,
  chat: probeChatStream,
  responses: probeResponsesStream,
};

async function main(): Promise<void> {
  console.log("Streaming probe — dumps every raw event from each provider path.");
  console.log(
    `PROBE=${PROBE}  MODEL=${MODEL_OVERRIDE ?? "(default)"}  THINK=${THINK}  FULL=${FULL}\n`,
  );

  if (PROBE === "all") {
    for (const [name, fn] of Object.entries(probes)) {
      try {
        await fn();
      } catch (err) {
        console.error(`\n[${name}] PROBE THREW:`, err);
      }
    }
  } else {
    const fn = probes[PROBE];
    if (!fn) {
      console.error(`Unknown PROBE=${PROBE}. Valid: sdk, chat, responses, all`);
      process.exitCode = 1;
      return;
    }
    try {
      await fn();
    } catch (err) {
      console.error(`\n[${PROBE}] PROBE THREW:`, err);
      process.exitCode = 1;
    }
  }
}

await main();
