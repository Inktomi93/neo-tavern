import { createHash } from "node:crypto";
import type { OpenRouter } from "@openrouter/sdk";
import { getLog } from "../../observability/logger";
import { type ChatTurnResult, type ChatTurnUsage, normalizeFinishReason } from "../turn";
import { ANTHROPIC_CACHE, effectiveProviderRouting, isAnthropicModel } from "./caching";
import { getOpenRouterClient } from "./client";
import {
  joinSystemPrompt,
  lookupContextWindow,
  mapOpenRouterError,
  type RawTurnParams,
  toReasoningEffort,
} from "./shared";

// ── Responses runner (sdk.beta.responses.send) ─────────────────────────────────

// The slice of OpenResponsesResult we read.
interface ResponsesView {
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  outputText?: string;
  // The finish signal: status ("completed"|"incomplete"|…) + the reason when incomplete
  // ("max_output_tokens"|"content_filter"). incomplete reason wins (it's more specific).
  status?: string;
  incompleteDetails?: { reason?: string } | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number | null;
    costDetails?: {
      upstreamInferenceCost?: number | null;
      upstreamInferenceInputCost?: number | null;
      upstreamInferenceOutputCost?: number | null;
    } | null;
    inputTokensDetails?: { cachedTokens?: number };
    outputTokensDetails?: { reasoningTokens?: number };
    isByok?: boolean;
  };
}

function buildResponsesInput(
  history: RawTurnParams["history"],
): Array<{ role: string; content: string }> {
  const items = history
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
  // Responses input can't start with an assistant turn (e.g. a seeded greeting) — pad with a user stub.
  if (items[0]?.role === "assistant") {
    items.unshift({ role: "user", content: "…" });
  }
  return items;
}

function extractResponsesReply(view: ResponsesView): string {
  if (typeof view.outputText === "string" && view.outputText.length > 0) {
    return view.outputText.trim();
  }
  return (view.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/**
 * One Responses-API turn over OpenRouter (sdk.beta.responses.send) — the OpenAI-style endpoint.
 * Provider-aware caching: Anthropic models get the top-level cache_control directive; for the rest
 * (OpenAI et al.) we set a stable `promptCacheKey` derived from the system prompt so the provider's
 * automatic cache routes consistently across turns (the correct field, replacing the old sha1 hack).
 */
export async function runRawTurn(params: RawTurnParams): Promise<ChatTurnResult> {
  const startedAt = Date.now();
  const instructions = joinSystemPrompt(params.systemPrompt);
  const cfg = params.generation ?? {};
  const anthropic = isAnthropicModel(params.model);

  // A stable per-system-prompt key lets OpenAI-style providers reuse their automatic cache across
  // turns. Anthropic uses the cache_control directive instead (promptCacheKey is a no-op there).
  const promptCacheKey =
    !anthropic && instructions.length > 0
      ? createHash("sha1").update(`${params.model} ${instructions}`).digest("hex").slice(0, 32)
      : undefined;
  const responsesProvider = effectiveProviderRouting(params.model, params.providerRouting);
  const reasoningEffort = toReasoningEffort(cfg);

  const responsesRequest = {
    model: params.model,
    input: buildResponsesInput(params.history),
    ...(instructions.length > 0 ? { instructions } : {}),
    ...(anthropic && instructions.length > 0 ? { cacheControl: ANTHROPIC_CACHE } : {}),
    ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.topP !== undefined ? { topP: cfg.topP } : {}),
    ...(cfg.maxOutputTokens !== undefined ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
    ...(reasoningEffort !== undefined
      ? { reasoning: { effort: reasoningEffort, summary: "auto" } }
      : {}),
    ...(responsesProvider !== undefined ? { provider: responsesProvider } : {}),
  };

  let view: ResponsesView;
  try {
    if (params.onDelta) {
      // Streaming mode for the Responses API. OpenRouter emits typed SSE events discriminated by
      // `event.type`. The events we handle:
      //   "response.output_text.delta"            → reply text chunk (event.delta: string)
      //   "response.reasoning_text.delta"         → CoT reasoning chunk (event.delta: string)
      //   "response.reasoning_summary_text.delta" → compressed reasoning summary (event.delta: string)
      //   "response.completed"                    → final snapshot (event.response has full usage)
      //   "response.incomplete"                   → same shape, but truncated
      //   "response.failed"                       → server-side failure (event.response.error)
      //   "error"                                 → in-band stream error (event.code, event.message)
      const stream = await getOpenRouterClient(params.openRouterApiKey).beta.responses.send({
        responsesRequest: { ...responsesRequest, stream: true },
      } as Parameters<OpenRouter["beta"]["responses"]["send"]>[0] & {
        responsesRequest: { stream: true };
      });
      let replyText = "";
      let usage: ResponsesView["usage"];
      let status: string | undefined;
      let incompleteDetails: { reason?: string } | null | undefined;
      for await (const event of stream as AsyncIterable<{
        type: string;
        delta?: string;
        response?: {
          status?: string;
          incompleteDetails?: { reason?: string } | null;
          usage?: ResponsesView["usage"];
          error?: { code: number | string | null; message: string } | null;
        };
        code?: string | null;
        message?: string;
      }>) {
        switch (event.type) {
          case "response.output_text.delta":
            if (typeof event.delta === "string" && event.delta.length > 0) {
              replyText += event.delta;
              params.onDelta({ chatId: params.chatId ?? "", kind: "text", text: event.delta });
            }
            break;
          case "response.reasoning_text.delta":
          case "response.reasoning_summary_text.delta":
            if (typeof event.delta === "string" && event.delta.length > 0) {
              params.onDelta({ chatId: params.chatId ?? "", kind: "reasoning", text: event.delta });
            }
            break;
          case "response.completed":
          case "response.incomplete": {
            const resp = event.response;
            if (resp) {
              if (resp.status !== undefined) status = resp.status;
              if (resp.incompleteDetails !== undefined) incompleteDetails = resp.incompleteDetails;
              if (resp.usage !== undefined) usage = resp.usage;
            }
            break;
          }
          case "response.failed": {
            // Provider-level failure embedded in the stream. Promote to a thrown error so
            // mapOpenRouterError can classify it and the turn records the correct kind.
            const resp = event.response;
            const errMsg = resp?.error?.message ?? "responses stream: response.failed";
            const errCode = resp?.error?.code;
            const syntheticErr = Object.assign(new Error(errMsg), {
              statusCode: typeof errCode === "number" ? errCode : undefined,
            });
            throw syntheticErr;
          }
          case "error": {
            // In-band SSE error — code is a string like "server_error", not an HTTP status;
            // wrap and let mapOpenRouterError fall through to the message-heuristic path.
            const syntheticErr = Object.assign(
              new Error(event.message ?? "responses stream error"),
              {
                statusCode: undefined,
              },
            );
            throw syntheticErr;
          }
          default:
            // lifecycle events (response.created, response.in_progress, content_part.added/done,
            // web_search_call.*, image_gen_call.*, function_call_args.*, annotation_added, …)
            break;
        }
      }
      view = {
        outputText: replyText,
        ...(usage !== undefined ? { usage } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(incompleteDetails !== null && incompleteDetails !== undefined
          ? { incompleteDetails }
          : {}),
      };
    } else {
      const result = await getOpenRouterClient(params.openRouterApiKey).beta.responses.send({
        responsesRequest,
      } as Parameters<OpenRouter["beta"]["responses"]["send"]>[0]);
      view = result as unknown as ResponsesView;
    }
  } catch (error) {
    const mapped = mapOpenRouterError(error, params.model, "responses");
    getLog().error(
      {
        model: params.model,
        status: mapped.apiErrorStatus,
        kind: mapped.kind,
        retryable: mapped.retryable,
        err: mapped.message,
      },
      "openrouter: responses turn failed",
    );
    throw mapped;
  }

  const u = view.usage;
  const uCostDetails = u?.costDetails;
  const usage: ChatTurnUsage = {
    model: params.model,
    tokensIn: u?.inputTokens ?? 0,
    tokensOut: u?.outputTokens ?? 0,
    cacheReadTokens: u?.inputTokensDetails?.cachedTokens ?? 0,
    cacheWriteTokens: 0,
    // 5m/1h split is Anthropic/sdk-internal; null (NA) not 0. contextWindow ← catalog; maxOutput ← request.
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
    reasoningTokens: u?.outputTokensDetails?.reasoningTokens ?? null,
    contextWindow: await lookupContextWindow(params.model),
    maxOutputTokens: cfg.maxOutputTokens ?? null,
    webSearchRequests: 0,
    costUsd: u?.cost ?? 0,
    costDetails:
      uCostDetails != null
        ? {
            totalUsd: uCostDetails.upstreamInferenceCost ?? 0,
            promptUsd: uCostDetails.upstreamInferenceInputCost ?? 0,
            completionUsd: uCostDetails.upstreamInferenceOutputCost ?? 0,
          }
        : null,
    isByok: u?.isByok ?? null,
  };

  getLog().info(
    {
      model: params.model,
      anthropicCaching: anthropic,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - startedAt,
    },
    "openrouter: responses turn complete",
  );

  // The incomplete reason (e.g. max_output_tokens) is the specific signal; else the status.
  const responsesFinish = view.incompleteDetails?.reason ?? view.status ?? null;
  return {
    reply: extractResponsesReply(view),
    sessionId: "",
    stopReason: responsesFinish,
    terminalReason: null,
    finishReason: normalizeFinishReason(responsesFinish),
    ttftMs: null,
    durationApiMs: Date.now() - startedAt,
    apiErrorStatus: null,
    numTurns: 1,
    usage,
    events: [],
    rateLimit: null,
  };
}
