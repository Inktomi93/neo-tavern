import type {
  ModelUsage,
  NonNullableUsage,
  SDKAssistantMessageError,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultError,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import { DEFAULT_CHAT_MODEL_ID } from "../../shared/models";
import { consumeTurnStream, disciplineOptions } from "./claude-sdk";
import { TurnError, type TurnEvent } from "./turn";

// The proxy's worst leak: a host plugin's SessionStart hook (superpowers) injected
// ~3.4k tokens into every request. These lock the config that prevents that class
// of bug — if someone "helpfully" loosens it, a test goes red.
const KEY_MDS = "CLAUDE_CODE_DISABLE_CLAUDE_MDS";

describe("Claude provider discipline — locks the proxy plugin/MCP/CLAUDE.md leak", () => {
  test("loads NO host settings/plugins/hooks (settingSources is empty)", () => {
    expect(disciplineOptions().settingSources).toEqual([]);
  });

  test("loads NO MCP servers and ignores host MCP config", () => {
    const options = disciplineOptions();

    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
  });

  test("enables NO built-in tools — this is RP, not coding", () => {
    expect(disciplineOptions().tools).toEqual([]);
  });

  test("its subprocess env kills CLAUDE.md injection", () => {
    expect(disciplineOptions().env[KEY_MDS]).toBe("true");
  });

  test("sets generation knobs explicitly — thinking off, Opus capped at 200k, ambient effort neutralized", () => {
    const env = disciplineOptions().env;

    // Owner-chosen RP defaults (verified via scripts/env-knob-probe.ts), set explicitly so they
    // don't depend on the host's ambient env (which leaks CLAUDE_EFFORT=xhigh). Bracket access via
    // const keys (like KEY_MDS) sidesteps the index-signature dot/bracket lint conflict.
    const KEY_THINKING = "CLAUDE_CODE_DISABLE_THINKING";
    const KEY_1M = "CLAUDE_CODE_DISABLE_1M_CONTEXT";
    const KEY_EFFORT = "CLAUDE_EFFORT";
    expect(env[KEY_THINKING]).toBe("1");
    expect(env[KEY_1M]).toBe("1");
    expect(env[KEY_EFFORT]).toBeUndefined();
  });
});

// ── Fixtures: hand-built SDK message frames ──────────────────────────────────
// consumeTurnStream is the pure stream → result mapping (no subprocess), so we drive
// it with a synthetic stream — the provider's "request/response mapping" the doctrine
// says to test here. Real auth/generation is covered by `pnpm verify:claude`.
const MODEL_USAGE: ModelUsage = {
  inputTokens: 120,
  outputTokens: 30,
  cacheReadInputTokens: 4674,
  cacheCreationInputTokens: 200,
  webSearchRequests: 0,
  costUSD: 0.0021,
  contextWindow: 200000,
  maxOutputTokens: 8192,
};

// NonNullableUsage spans the whole Beta usage surface; the code only reads
// usage.cache_creation, so fill that and cast the rest.
const USAGE = {
  input_tokens: 120,
  output_tokens: 30,
  cache_read_input_tokens: 4674,
  cache_creation_input_tokens: 200,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 },
} as unknown as NonNullableUsage;

async function* streamOf(...messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const message of messages) {
    yield message;
  }
}

// The SDK UUID type is a 5-segment template literal; this keeps fixtures readable
// while satisfying it.
const uuid = (seed: string) => `id-0-0-0-${seed}` as const;

function assistant(text: string): SDKMessage {
  return {
    type: "assistant",
    message: { stop_reason: "end_turn", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid: "u-assistant",
    session_id: "sess-1",
  } as unknown as SDKMessage;
}

function resultSuccess(over: Partial<SDKResultSuccess> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0.0021,
    usage: USAGE,
    modelUsage: { [DEFAULT_CHAT_MODEL_ID]: MODEL_USAGE },
    permission_denials: [],
    uuid: uuid("result"),
    session_id: "sess-1",
    ...over,
  };
}

function resultError(
  subtype: SDKResultError["subtype"],
  over: Partial<SDKResultError> = {},
): SDKMessage {
  return {
    type: "result",
    subtype,
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: USAGE,
    modelUsage: { [DEFAULT_CHAT_MODEL_ID]: MODEL_USAGE },
    permission_denials: [],
    errors: ["boom"],
    uuid: uuid("result-err"),
    session_id: "sess-1",
    ...over,
  };
}

function compactBoundary(): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "auto",
      pre_tokens: 150000,
      post_tokens: 20000,
      preserved_messages: { anchor_uuid: uuid("anchor"), uuids: [uuid("m1"), uuid("m2")] },
    },
    uuid: uuid("compact"),
    session_id: "sess-1",
  };
}

function apiRetry(error: SDKAssistantMessageError): SDKMessage {
  return {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 5,
    retry_delay_ms: 1000,
    error_status: 529,
    error,
    uuid: uuid("retry"),
    session_id: "sess-1",
  };
}

function rateLimitEvent(status: SDKRateLimitInfo["status"], resetsAt?: number): SDKMessage {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      rateLimitType: "five_hour",
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    },
    uuid: uuid("ratelimit"),
    session_id: "sess-1",
  };
}

function authStatus(): SDKMessage {
  return {
    type: "auth_status",
    isAuthenticating: true,
    output: [],
    uuid: uuid("auth"),
    session_id: "sess-1",
  };
}

const ctx = { model: DEFAULT_CHAT_MODEL_ID, resumed: false };

async function expectTurnError(stream: AsyncIterable<SDKMessage>): Promise<TurnError> {
  let caught: unknown;
  try {
    await consumeTurnStream(stream, ctx);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TurnError);
  return caught as TurnError;
}

describe("consumeTurnStream — maps the SDK message stream to a turn result", () => {
  test("a clean turn returns reply, session id, and rich usage", async () => {
    const result = await consumeTurnStream(
      streamOf(assistant("hello there"), resultSuccess({ ttft_ms: 250 })),
      ctx,
    );

    expect(result.reply).toBe("hello there");
    expect(result.sessionId).toBe("sess-1");
    expect(result.stopReason).toBe("end_turn");
    expect(result.ttftMs).toBe(250);
    expect(result.usage.tokensIn).toBe(120);
    expect(result.usage.contextWindow).toBe(200000);
    expect(result.usage.maxOutputTokens).toBe(8192);
    // The 1h bucket is the sub-mode default — the split is preserved off usage.cache_creation.
    expect(result.usage.cacheCreation1hTokens).toBe(200);
    expect(result.usage.cacheCreation5mTokens).toBe(0);
    expect(result.events).toHaveLength(0);
  });

  test("a compaction boundary becomes an event but does NOT fail the turn", async () => {
    const result = await consumeTurnStream(
      streamOf(compactBoundary(), assistant("after compaction"), resultSuccess()),
      ctx,
    );

    expect(result.reply).toBe("after compaction");
    const compaction = result.events.find((event) => event.kind === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction?.kind === "compaction" && compaction.trigger).toBe("auto");
    // preserved_messages present → the resume relink survives.
    expect(compaction?.kind === "compaction" && compaction.preserved).toBe(true);
  });

  test("a rejected rate-limit + failed result → typed rate_limit error carrying resetsAt (s→ms)", async () => {
    // The SDK reports resetsAt in epoch SECONDS; the runner normalizes to our canonical epoch-ms.
    const resetsAtSeconds = Math.floor((Date.now() + 60_000) / 1000);
    const error = await expectTurnError(
      streamOf(rateLimitEvent("rejected", resetsAtSeconds), resultError("error_during_execution")),
    );

    expect(error.kind).toBe("rate_limit");
    expect(error.retryable).toBe(true);
    expect(error.resetsAt).toBe(resetsAtSeconds * 1000);
  });

  test("an auth_failed api_retry that then fails → non-retryable auth_failed (the ban canary)", async () => {
    const error = await expectTurnError(
      streamOf(apiRetry("authentication_failed"), resultError("error_during_execution")),
    );

    expect(error.kind).toBe("auth_failed");
    expect(error.retryable).toBe(false);
    expect(error.sdkError).toBe("authentication_failed");
  });

  test("error_max_budget_usd maps to a non-retryable billing error", async () => {
    const error = await expectTurnError(streamOf(resultError("error_max_budget_usd")));

    expect(error.kind).toBe("billing");
    expect(error.retryable).toBe(false);
    expect(error.resultSubtype).toBe("error_max_budget_usd");
  });

  test("auth_status is surfaced as an event without aborting the turn", async () => {
    const result = await consumeTurnStream(
      streamOf(authStatus(), assistant("ok"), resultSuccess()),
      ctx,
    );

    expect(result.events.some((event) => event.kind === "auth_status")).toBe(true);
    expect(result.reply).toBe("ok");
  });

  test("events are forwarded to the onEvent sink as they arrive", async () => {
    const seen: TurnEvent["kind"][] = [];
    await consumeTurnStream(streamOf(compactBoundary(), assistant("x"), resultSuccess()), {
      ...ctx,
      onEvent: (event) => seen.push(event.kind),
    });

    expect(seen).toContain("compaction");
  });
});
