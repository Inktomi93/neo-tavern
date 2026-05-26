import {
  type Options,
  query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultError,
  type SDKStatus,
  type SessionStore,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type TerminalReason,
} from "@anthropic-ai/claude-agent-sdk";
import { type ChatModelId, DEFAULT_CHAT_MODEL_ID } from "../../shared/models";
import { buildClaudeSdkEnv, env } from "../env";
import { getLog } from "../observability/logger";

// sdk-mode (YGWYG) chats run through the Claude Agent SDK, which spawns the
// official Claude Code runtime and authenticates with the host's `claude login`
// (Max subscription) — no API key, no token extraction. The options below strip
// everything that silently inflates token use, borrowed from st-claude-proxy's
// hard-won config: no built-in tools, no MCP servers, and no user settings
// (which is how plugins/hooks like superpowers sneak ~3.4k tokens into every
// request). CLAUDE.md injection is killed via buildClaudeSdkEnv().
// Exported so the leak-prevention contract is locked by tests (see the proxy
// painpoints in claude-sdk.test.ts).
export function disciplineOptions() {
  return {
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    env: buildClaudeSdkEnv(),
  };
}

// Opt-in subprocess observability. When LOG_LEVEL is debug/trace we enable the
// SDK's own `--debug` instrumentation (this is what exposes plugin/hook injection
// — "Registered N hooks from M plugins"; with our config it proves 0/0) and pipe
// the raw subprocess stderr into the request logger. Both emit METADATA only
// (endpoints, request ids, source) — never the assembled prompt or reply (see
// docs/sdk-notes.md "Observing injection"). Kept OUT of disciplineOptions() so
// that helper stays the pure leak contract the tests lock.
function observabilityOptions(): Partial<Options> {
  if (env.LOG_LEVEL !== "debug" && env.LOG_LEVEL !== "trace") {
    return {};
  }
  return {
    debug: true,
    stderr: (data: string) => {
      getLog().debug({ sdk: "stderr" }, data.trimEnd());
    },
  };
}

// Build the SDK `systemPrompt` from our assembled static/dynamic halves. The static half is the
// cacheable prefix; when a dynamic half exists we place it after SYSTEM_PROMPT_DYNAMIC_BOUNDARY so
// per-turn changes (keyword-WI, retrieved memory) don't bust the cached prefix (docs/sdk-notes.md).
// Returns undefined when there's nothing to send (the SDK then uses its own default).
function buildSystemPrompt(
  sp: { static: string; dynamic: string } | undefined,
): string | string[] | undefined {
  if (sp === undefined) {
    return undefined;
  }
  const staticPart = sp.static.trim();
  const dynamicPart = sp.dynamic.trim();
  if (staticPart.length === 0 && dynamicPart.length === 0) {
    return undefined;
  }
  if (dynamicPart.length === 0) {
    return staticPart;
  }
  return [staticPart, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicPart];
}

export interface ClaudeAuthResult {
  /** True when the query completed without an error result. */
  ok: boolean;
  /** From the SDK init message: "none" means the host `claude login` (sub) was used, not an API key. */
  apiKeySource: string;
  model: string;
  reply: string;
  /** Metered-equivalent cost; on a flat-rate Max sub this is allowance, not dollars. */
  costUsd: number;
}

/**
 * One-shot auth check: sends a trivial prompt and reports which credential the
 * SDK used. Drives `pnpm verify:claude`. Defaults to the cheapest tier.
 */
export async function verifyClaudeAuth(
  model: ChatModelId = DEFAULT_CHAT_MODEL_ID,
): Promise<ClaudeAuthResult> {
  const stream = query({
    prompt: "Reply with exactly the two characters: ok",
    options: { ...disciplineOptions(), ...observabilityOptions(), model, maxTurns: 1 },
  });

  let apiKeySource = "unknown";
  let reply = "";
  let costUsd = 0;
  let ok = false;

  for await (const message of stream) {
    if (message.type === "system" && message.subtype === "init") {
      apiKeySource = message.apiKeySource;
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          reply += block.text;
        }
      }
    } else if (message.type === "result") {
      ok = !message.is_error;
      costUsd = message.total_cost_usd;
    }
  }

  return { ok, apiKeySource, model, reply: reply.trim(), costUsd };
}

// ── Typed failure boundary ───────────────────────────────────────────────────
// The error a turn surfaces, in PROVIDER-AGNOSTIC terms. `kind` is the public
// surface every provider (sdk-mode now; raw-mode/OpenRouter in Phase 5) maps its
// failures onto, so the transport + UI key off ONE vocabulary and never re-derive
// the mapping per provider. The raw SDK code rides along as a side detail.
export type TurnErrorKind =
  | "rate_limit" // sub allowance exhausted — retryable once it resets
  | "auth_failed" // credential rejected — the ban-risk canary; NOT retryable, alert loudly
  | "billing" // out of budget / billing problem
  | "invalid" // malformed request — a bug on our side
  | "model_unavailable" // unknown/unsupported model
  | "server" // upstream 5xx / execution error — transient, retryable
  | "max_output" // hit the output-token ceiling mid-reply — retry can continue
  | "aborted" // turn-limit / abort
  | "unknown";

export interface ClaudeTurnErrorInit {
  kind: TurnErrorKind;
  retryable: boolean;
  message: string;
  /** Raw SDK assistant-error code, when the failure came from one (Phase-5 bridge keeps it). */
  sdkError?: SDKAssistantMessageError;
  /** Raw SDK result error subtype, when the failure was an error result. */
  resultSubtype?: SDKResultError["subtype"];
  /** For rate_limit: epoch ms when the window resets (from a rate_limit_event seen this turn). */
  resetsAt?: number;
  cause?: unknown;
}

export class ClaudeTurnError extends Error {
  readonly kind: TurnErrorKind;
  readonly retryable: boolean;
  readonly sdkError: SDKAssistantMessageError | undefined;
  readonly resultSubtype: SDKResultError["subtype"] | undefined;
  readonly resetsAt: number | undefined;

  constructor(init: ClaudeTurnErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ClaudeTurnError";
    this.kind = init.kind;
    this.retryable = init.retryable;
    this.sdkError = init.sdkError;
    this.resultSubtype = init.resultSubtype;
    this.resetsAt = init.resetsAt;
  }
}

// Exhaustive over SDKAssistantMessageError (no default → tsc flags a new SDK code).
function classifyAssistantError(code: SDKAssistantMessageError): {
  kind: TurnErrorKind;
  retryable: boolean;
} {
  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return { kind: "auth_failed", retryable: false };
    case "billing_error":
      return { kind: "billing", retryable: false };
    case "rate_limit":
      return { kind: "rate_limit", retryable: true };
    case "invalid_request":
      return { kind: "invalid", retryable: false };
    case "model_not_found":
      return { kind: "model_unavailable", retryable: false };
    case "max_output_tokens":
      return { kind: "max_output", retryable: true };
    case "server_error":
      return { kind: "server", retryable: true };
    case "unknown":
      return { kind: "unknown", retryable: false };
  }
}

// Exhaustive over SDKResultError["subtype"].
function classifyResultSubtype(subtype: SDKResultError["subtype"]): {
  kind: TurnErrorKind;
  retryable: boolean;
} {
  switch (subtype) {
    case "error_during_execution":
      return { kind: "server", retryable: true };
    case "error_max_turns":
      return { kind: "aborted", retryable: false };
    case "error_max_budget_usd":
      return { kind: "billing", retryable: false };
    case "error_max_structured_output_retries":
      return { kind: "invalid", retryable: false };
  }
}

// ── Per-turn structured events ───────────────────────────────────────────────
// Everything the stream tells us BESIDES the reply text + final usage. Metadata
// only (never RP content). Returned on ChatTurnResult.events AND logged live, so
// a long chat's auto-compaction, transient retries, and rate-limit warnings are
// observable via /api/_debug without scanning the model's output.
export interface RateLimitSnapshot {
  status: SDKRateLimitInfo["status"];
  rateLimitType: SDKRateLimitInfo["rateLimitType"];
  resetsAt: number | undefined;
  utilization: number | undefined;
}

export type TurnEvent =
  | {
      kind: "compaction";
      at: number;
      trigger: "manual" | "auto";
      preTokens: number;
      postTokens: number | undefined;
      durationMs: number | undefined;
      preserved: boolean;
    }
  | {
      kind: "api_retry";
      at: number;
      attempt: number;
      maxRetries: number;
      retryDelayMs: number;
      errorStatus: number | null;
      sdkError: SDKAssistantMessageError;
    }
  | {
      kind: "rate_limit";
      at: number;
      status: SDKRateLimitInfo["status"];
      rateLimitType: SDKRateLimitInfo["rateLimitType"];
      resetsAt: number | undefined;
      utilization: number | undefined;
    }
  | {
      kind: "status";
      at: number;
      status: SDKStatus;
      compactResult: "success" | "failed" | undefined;
    }
  | { kind: "auth_status"; at: number; isAuthenticating: boolean; error: string | undefined };

export interface ChatTurnUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Split of cache-creation tokens by TTL bucket (usage.cache_creation) — sub-mode defaults 1h. */
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  /** Model context window + output ceiling (from modelUsage) — drives the context-fill meter. */
  contextWindow: number;
  maxOutputTokens: number;
  costUsd: number;
}

export interface ChatTurnResult {
  reply: string;
  /** result.session_id — persist on the chat row so the next turn resumes it. */
  sessionId: string;
  stopReason: string | null;
  terminalReason: TerminalReason | null;
  /** Time-to-first-token (ms), when the SDK reported it. */
  ttftMs: number | null;
  /** Non-null when transient API errors occurred but retries recovered the turn. */
  apiErrorStatus: number | null;
  numTurns: number;
  usage: ChatTurnUsage;
  /** Compaction / retry / rate-limit / status / auth events seen this turn (metadata). */
  events: TurnEvent[];
  /** Latest rate-limit snapshot seen this turn, if any. */
  rateLimit: RateLimitSnapshot | null;
}

export interface ChatTurnParams {
  prompt: string;
  model: ChatModelId;
  /** Resume an existing session; omit for the first turn of a new chat. */
  resume?: string;
  /** Our DB-backed SessionStore — the SDK loads from it to resume and mirrors new frames into it. */
  sessionStore: SessionStore;
  /** Assembled character/system prompt. `static` becomes the cached prefix; `dynamic` (if any)
   *  goes after SYSTEM_PROMPT_DYNAMIC_BOUNDARY so it re-evaluates per turn without busting the
   *  cached prefix (see docs/sdk-notes.md). Built by domain/chat via shared/prompt-assemble. */
  systemPrompt?: { static: string; dynamic: string };
  /** Optional live event sink (compaction/retry/rate-limit/...). The streaming-UI seam:
   *  a future SSE subscription forwards these; default undefined = collect-and-return only.
   *  (Token-delta streaming via includePartialMessages is deliberately NOT wired yet — no
   *  consumer until the chat UI lands; see docs/sdk-notes.md.) */
  onEvent?: (event: TurnEvent) => void;
}

/**
 * One stateless YGWYG turn (the resume-per-message model). Spawns the runtime,
 * resumes from our store, consumes the FULL SDK message stream — classifying
 * compaction, retries, rate-limits, auth, and error results, not just the reply —
 * and returns the text + session id + per-turn usage + the structured events.
 * Throws {@link ClaudeTurnError} on any failure result so the caller can surface a
 * typed, provider-agnostic reason. Injected into `domain/chat` as a seam so the
 * turn logic is testable with a fake (no sub queries in `pnpm check`).
 */
// async (not a bare Promise-returning fn) so a synchronous throw from query() (e.g. bad
// options) surfaces as a rejected promise, not a sync throw at the call site.
export async function runChatTurn(params: ChatTurnParams): Promise<ChatTurnResult> {
  const systemPrompt = buildSystemPrompt(params.systemPrompt);
  const stream = query({
    prompt: params.prompt,
    options: {
      ...disciplineOptions(),
      ...observabilityOptions(),
      model: params.model,
      maxTurns: 1,
      sessionStore: params.sessionStore,
      ...(params.resume ? { resume: params.resume } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    },
  });
  return consumeTurnStream(stream, {
    model: params.model,
    resumed: Boolean(params.resume),
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
}

export interface TurnStreamContext {
  model: ChatModelId;
  resumed: boolean;
  onEvent?: (event: TurnEvent) => void;
}

/**
 * The SDK-message-stream → {@link ChatTurnResult} mapping, isolated from the subprocess
 * spawn so it is unit-testable with a hand-built stream (this is the "pure request/response
 * mapping" the provider layer is supposed to cover, per tests/AGENTS.md — the real spawn +
 * auth are exercised by `pnpm verify:claude`). Throws {@link ClaudeTurnError} on any failure
 * result; classifies compaction / retries / rate-limits / auth into `events` along the way.
 */
export async function consumeTurnStream(
  stream: AsyncIterable<SDKMessage>,
  ctx: TurnStreamContext,
): Promise<ChatTurnResult> {
  const startedAt = Date.now();

  let reply = "";
  let sessionId = "";
  let stopReason: string | null = null;
  let terminalReason: TerminalReason | null = null;
  let ttftMs: number | null = null;
  let apiErrorStatus: number | null = null;
  let numTurns = 0;
  let rateLimit: RateLimitSnapshot | null = null;
  // The specific assistant-error code from the last api_retry. Error RESULTS only
  // carry a generic subtype, so a rate-limit/auth failure that exhausted its retries
  // would otherwise be mis-classified as a bare "server" error — this preserves it.
  let lastRetryError: SDKAssistantMessageError | undefined;
  const events: TurnEvent[] = [];
  const usage: ChatTurnUsage = {
    model: ctx.model,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    costUsd: 0,
  };

  const emit = (event: TurnEvent) => {
    events.push(event);
    ctx.onEvent?.(event);
  };

  try {
    for await (const message of stream) {
      if ("session_id" in message && typeof message.session_id === "string") {
        sessionId = message.session_id;
      }

      switch (message.type) {
        case "assistant": {
          stopReason = message.message.stop_reason ?? stopReason;
          for (const block of message.message.content) {
            if (block.type === "text") {
              reply += block.text;
            }
          }
          break;
        }

        case "system": {
          switch (message.subtype) {
            case "compact_boundary": {
              const meta = message.compact_metadata;
              const event: TurnEvent = {
                kind: "compaction",
                at: Date.now(),
                trigger: meta.trigger,
                preTokens: meta.pre_tokens,
                postTokens: meta.post_tokens,
                durationMs: meta.duration_ms,
                preserved:
                  meta.preserved_messages !== undefined || meta.preserved_segment !== undefined,
              };
              emit(event);
              // INFO: a real context compaction on a long chat is worth seeing in the logs.
              getLog().info(
                {
                  trigger: meta.trigger,
                  preTokens: meta.pre_tokens,
                  postTokens: meta.post_tokens,
                  preserved: event.preserved,
                },
                "claude: context compacted",
              );
              break;
            }
            case "api_retry": {
              lastRetryError = message.error;
              emit({
                kind: "api_retry",
                at: Date.now(),
                attempt: message.attempt,
                maxRetries: message.max_retries,
                retryDelayMs: message.retry_delay_ms,
                errorStatus: message.error_status,
                sdkError: message.error,
              });
              const detail = {
                attempt: message.attempt,
                maxRetries: message.max_retries,
                retryDelayMs: message.retry_delay_ms,
                errorStatus: message.error_status,
                sdkError: message.error,
              };
              // An auth failure mid-retry is the ban-risk canary — escalate to error,
              // not the routine warn other retries get.
              if (classifyAssistantError(message.error).kind === "auth_failed") {
                getLog().error(detail, "claude: AUTH FAILURE during api retry (ban-risk canary)");
              } else {
                getLog().warn(detail, "claude: api retry");
              }
              break;
            }
            case "status": {
              emit({
                kind: "status",
                at: Date.now(),
                status: message.status,
                compactResult: message.compact_result,
              });
              if (message.compact_result === "failed") {
                getLog().warn({ compactError: message.compact_error }, "claude: compaction failed");
              }
              break;
            }
            // "init" — the SDK self-report. apiKeySource "none" = sub auth (the canary).
            // Logged at debug; the input-token count on the result is the durable signal.
            default:
              break;
          }
          break;
        }

        case "rate_limit_event": {
          const info = message.rate_limit_info;
          rateLimit = {
            status: info.status,
            rateLimitType: info.rateLimitType,
            resetsAt: info.resetsAt,
            utilization: info.utilization,
          };
          emit({
            kind: "rate_limit",
            at: Date.now(),
            status: info.status,
            rateLimitType: info.rateLimitType,
            resetsAt: info.resetsAt,
            utilization: info.utilization,
          });
          // WARN when we're being throttled/rejected; debug when merely "allowed".
          if (info.status === "allowed") {
            getLog().debug(
              { rateLimitType: info.rateLimitType, utilization: info.utilization },
              "claude: rate-limit ok",
            );
          } else {
            getLog().warn(
              {
                status: info.status,
                rateLimitType: info.rateLimitType,
                resetsAt: info.resetsAt,
                utilization: info.utilization,
              },
              "claude: rate-limited",
            );
          }
          break;
        }

        case "auth_status": {
          emit({
            kind: "auth_status",
            at: Date.now(),
            isAuthenticating: message.isAuthenticating,
            error: message.error,
          });
          // WARN unconditionally — auth state changing mid-turn is the ban-risk canary
          // the locked decisions name explicitly (never extract the token; watch auth).
          getLog().warn(
            { isAuthenticating: message.isAuthenticating, authError: message.error },
            "claude: auth status change",
          );
          break;
        }

        case "result": {
          numTurns = message.num_turns;
          terminalReason = message.terminal_reason ?? null;
          stopReason = message.stop_reason ?? stopReason;
          for (const modelUsage of Object.values(message.modelUsage)) {
            usage.tokensIn += modelUsage.inputTokens;
            usage.tokensOut += modelUsage.outputTokens;
            usage.cacheReadTokens += modelUsage.cacheReadInputTokens;
            usage.cacheWriteTokens += modelUsage.cacheCreationInputTokens;
            usage.costUsd += modelUsage.costUSD;
            usage.contextWindow = Math.max(usage.contextWindow, modelUsage.contextWindow);
            usage.maxOutputTokens = Math.max(usage.maxOutputTokens, modelUsage.maxOutputTokens);
          }
          // Guard despite the non-null type: a null/undefined at runtime here would throw
          // INSIDE the try, and the generic catch would wrap a SUCCESSFUL turn as a server
          // error (rolling back the user message) — the worst, hardest-to-reproduce failure.
          const cacheCreation = message.usage.cache_creation;
          if (cacheCreation) {
            usage.cacheCreation5mTokens = cacheCreation.ephemeral_5m_input_tokens;
            usage.cacheCreation1hTokens = cacheCreation.ephemeral_1h_input_tokens;
          }

          if (message.subtype === "success") {
            ttftMs = message.ttft_ms ?? null;
            apiErrorStatus = message.api_error_status ?? null;
            if (message.is_error) {
              // Defensive: a "success" subtype flagged is_error — treat as a server error.
              throw new ClaudeTurnError({
                kind: "server",
                retryable: true,
                message: "claude: result success-subtype flagged is_error",
              });
            }
          } else {
            // Prefer the specific assistant-error code (from a retry / rate-limit event)
            // over the generic result subtype, so rate-limit + auth failures keep their
            // identity instead of collapsing to "server".
            const rateLimited = rateLimit?.status === "rejected" || lastRetryError === "rate_limit";
            const specific: SDKAssistantMessageError | undefined = rateLimited
              ? "rate_limit"
              : lastRetryError;
            const classified =
              specific !== undefined
                ? classifyAssistantError(specific)
                : classifyResultSubtype(message.subtype);
            throw new ClaudeTurnError({
              kind: classified.kind,
              retryable: classified.retryable,
              message: `claude: turn failed (${message.subtype})${message.errors.length > 0 ? `: ${message.errors.join("; ")}` : ""}`,
              resultSubtype: message.subtype,
              ...(specific !== undefined ? { sdkError: specific } : {}),
              ...(classified.kind === "rate_limit" && rateLimit?.resetsAt !== undefined
                ? { resetsAt: rateLimit.resetsAt }
                : {}),
            });
          }
          break;
        }

        // Streaming token deltas (stream_event) arrive only with includePartialMessages,
        // which we don't set yet (full reply comes from the `assistant` message). Tool /
        // task / hook / memory / permission events can't fire with our locked config
        // (tools:[], no MCP, no subagents) — log unexpected ones at debug, never crash.
        case "stream_event":
          break;
        default:
          getLog().debug({ messageType: message.type }, "claude: unhandled sdk message type");
          break;
      }
    }
  } catch (error) {
    if (error instanceof ClaudeTurnError) {
      getLog().error(
        {
          model: ctx.model,
          resumed: ctx.resumed,
          kind: error.kind,
          retryable: error.retryable,
          sdkError: error.sdkError,
          resultSubtype: error.resultSubtype,
        },
        "claude: turn failed",
      );
      throw error;
    }
    // Unexpected thrown exception (spawn/network/subprocess) — wrap as a transient
    // server error so the caller has the same typed surface. Likely retryable.
    const wrapped = new ClaudeTurnError({
      kind: "server",
      retryable: true,
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
    getLog().error(
      { model: ctx.model, resumed: ctx.resumed, kind: wrapped.kind, err: wrapped.message },
      "claude: turn threw",
    );
    throw wrapped;
  }

  // Metadata only — NEVER the prompt/reply (RP content lives in the DB). Cost/tokens/latency
  // are the analytics-grade signals you want curl-able per turn (also stored on the message).
  getLog().info(
    {
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheCreation5mTokens: usage.cacheCreation5mTokens,
      cacheCreation1hTokens: usage.cacheCreation1hTokens,
      contextWindow: usage.contextWindow,
      maxOutputTokens: usage.maxOutputTokens,
      costUsd: usage.costUsd,
      stopReason,
      terminalReason,
      ttftMs,
      apiErrorStatus,
      eventCount: events.length,
      resumed: ctx.resumed,
      durationMs: Date.now() - startedAt,
    },
    "claude: turn complete",
  );

  return {
    reply: reply.trim(),
    sessionId,
    stopReason,
    terminalReason,
    ttftMs,
    apiErrorStatus,
    numTurns,
    usage,
    events,
    rateLimit,
  };
}
