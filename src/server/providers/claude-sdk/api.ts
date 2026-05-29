import {
  query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type TerminalReason,
} from "@anthropic-ai/claude-agent-sdk";
import { type ChatModelId, DEFAULT_CHAT_MODEL_ID } from "../../../shared/models";
import { secondsToMs } from "../../../shared/time";
import { getLog } from "../../observability/logger";
import {
  type ChatTurnResult,
  type ChatTurnUsage,
  normalizeFinishReason,
  type RateLimitSnapshot,
  TurnError,
  type TurnEvent,
} from "../turn";
import {
  buildSystemPrompt,
  disciplineOptions,
  observabilityOptions,
  toSdkGeneration,
} from "./config";
import { classifyAssistantError, classifyResultSubtype } from "./errors";
import type { ChatTurnParams, ClaudeAuthResult, TurnStreamContext } from "./types";

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
// async (not a bare Promise-returning fn) so a synchronous throw from query() (e.g. bad
// options) surfaces as a rejected promise, not a sync throw at the call site.
export async function runChatTurn(params: ChatTurnParams): Promise<ChatTurnResult> {
  const systemPrompt = buildSystemPrompt(params.systemPrompt);
  const gen = toSdkGeneration(params.generation);
  const stream = query({
    prompt: params.prompt,
    options: {
      ...disciplineOptions(params.source, gen.envOverrides, params.openRouterApiKey),
      ...observabilityOptions(),
      ...gen.options,
      includePartialMessages: Boolean(params.onDelta),
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
    ...(params.onDelta ? { onDelta: params.onDelta } : {}),
  });
}
/**
 * The SDK-message-stream → {@link ChatTurnResult} mapping, isolated from the subprocess
 * spawn so it is unit-testable with a hand-built stream (this is the "pure request/response
 * mapping" the provider layer is supposed to cover, per tests/AGENTS.md — the real spawn +
 * auth are exercised by `pnpm verify:claude`). Throws {@link TurnError} on any failure
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
  let durationApiMs: number | null = null;
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
    // sdk always reports these; 0 as initial sentinel (not null), filled by result message.
    reasoningTokens: null, // sdk doesn't expose CoT token count — set null (NA)
    contextWindow: 0,
    maxOutputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
    // sdk gives a single total costUSD — no prompt/completion split available
    costDetails: null,
    isByok: null, // Max sub path — no BYOK concept applies
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
          // The SDK reports resetsAt in epoch SECONDS — normalize to our canonical epoch-ms at the
          // boundary so everything downstream (UI countdown, TurnError) is one unit (shared/time.ts).
          const resetsAtMs = secondsToMs(info.resetsAt);
          // `isUsingOverage` is the ban-risk canary: when true the account has exhausted its
          // subscription limit and is drawing on overage credits. Alert louder than a plain warning.
          const infoObj = info as { isUsingOverage?: unknown; surpassedThreshold?: unknown };
          const isUsingOverage = infoObj.isUsingOverage as boolean | undefined;
          const surpassedThreshold = infoObj.surpassedThreshold as number | undefined;
          rateLimit = {
            status: info.status,
            rateLimitType: info.rateLimitType,
            resetsAt: resetsAtMs,
            utilization: info.utilization,
            isUsingOverage,
            surpassedThreshold,
          };
          emit({
            kind: "rate_limit",
            at: Date.now(),
            status: info.status,
            rateLimitType: info.rateLimitType,
            resetsAt: resetsAtMs,
            utilization: info.utilization,
          });
          // WARN when throttled/rejected or on overage; debug when merely "allowed".
          if (info.status === "allowed" && !isUsingOverage) {
            getLog().debug(
              { rateLimitType: info.rateLimitType, utilization: info.utilization },
              "claude: rate-limit ok",
            );
          } else {
            const logLevel = isUsingOverage ? "error" : "warn";
            getLog()[logLevel](
              {
                status: info.status,
                rateLimitType: info.rateLimitType,
                resetsAt: resetsAtMs,
                utilization: info.utilization,
                isUsingOverage: isUsingOverage ?? false,
                surpassedThreshold,
              },
              isUsingOverage ? "claude: RATE LIMIT OVERAGE — ban risk" : "claude: rate-limited",
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
            usage.webSearchRequests += modelUsage.webSearchRequests ?? 0;
            usage.contextWindow = Math.max(usage.contextWindow ?? 0, modelUsage.contextWindow);
            usage.maxOutputTokens = Math.max(
              usage.maxOutputTokens ?? 0,
              modelUsage.maxOutputTokens,
            );
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
            durationApiMs =
              ((message as { duration_api_ms?: unknown }).duration_api_ms as number | null) ?? null;
            apiErrorStatus = message.api_error_status ?? null;
            if (message.is_error) {
              // Defensive: a "success" subtype flagged is_error — treat as a server error.
              throw new TurnError({
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
            throw new TurnError({
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
        case "stream_event": {
          const raw = (
            message as { event?: { type?: string; delta?: { type?: string; text?: string } } }
          ).event;
          if (
            raw?.type === "content_block_delta" &&
            raw.delta?.type === "text_delta" &&
            typeof raw.delta.text === "string"
          ) {
            ctx.onDelta?.({ chatId: "", kind: "text", text: raw.delta.text });
          }
          break;
        }
        default:
          getLog().debug({ messageType: message.type }, "claude: unhandled sdk message type");
          break;
      }
    }
  } catch (error) {
    if (error instanceof TurnError) {
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
    const wrapped = new TurnError({
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
      reasoningTokens: usage.reasoningTokens,
      webSearchRequests: usage.webSearchRequests,
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
    // stop_reason is the per-message signal; fall back to the loop-level terminalReason.
    finishReason: normalizeFinishReason(stopReason ?? terminalReason),
    ttftMs,
    durationApiMs,
    apiErrorStatus,
    numTurns,
    usage,
    events,
    rateLimit,
  };
}
