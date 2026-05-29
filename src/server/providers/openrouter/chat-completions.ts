import type { OpenRouter } from "@openrouter/sdk";
import { getLog } from "../../observability/logger";
import { type ChatTurnResult, type ChatTurnUsage, normalizeFinishReason } from "../turn";
import { ANTHROPIC_CACHE, effectiveProviderRouting, isAnthropicModel } from "./caching";
import { getOpenRouterClient } from "./client";
import {
  chatSamplingFields,
  lookupContextWindow,
  mapOpenRouterError,
  type RawTurnParams,
  toReasoningEffort,
} from "./shared";

// ── Chat Completions runner (sdk.chat.send) ────────────────────────────────────

// The slice of ChatResult we read (its full type is a large generated union).
interface ChatResultView {
  id?: string;
  choices?: Array<{
    message?: { content?: unknown };
    finishReason?: string | null;
  }>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    cost?: number | null;
    costDetails?: {
      upstreamInferenceCost?: number | null;
      upstreamInferencePromptCost?: number | null;
      upstreamInferenceCompletionsCost?: number | null;
    } | null;
    promptTokensDetails?: { cachedTokens?: number; cacheWriteTokens?: number } | null;
    completionTokensDetails?: { reasoningTokens?: number } | null;
    isByok?: boolean;
  };
}

function extractChatReply(view: ChatResultView): string {
  const content = view.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type?: string; text?: string } =>
          part !== null && typeof part === "object",
      )
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

// The system message for a chat-completions turn, with provider-aware caching. For Anthropic we
// emit PER-BLOCK cache_control on the STATIC text block — this pins the cache breakpoint at the
// stable system prompt so it's written once and reused every turn. (The top-level cacheControl
// directive instead pins the breakpoint at the LAST block — the volatile newest user message — so
// no reusable cache forms; measured live, cacheWrite stayed 0.) The dynamic half goes in a second
// (uncached) block after it, mirroring sdk-mode's boundary. Non-Anthropic models cache automatically
// → a plain joined string (sending Anthropic cache_control to them is wrong).
type ChatSystemMessage =
  | { role: "system"; content: string }
  | {
      role: "system";
      content: Array<{
        type: "text";
        text: string;
        cacheControl?: typeof ANTHROPIC_CACHE;
      }>;
    };

function buildChatSystemMessage(
  staticPart: string,
  dynamicPart: string,
  anthropic: boolean,
): ChatSystemMessage | null {
  if (staticPart.length === 0 && dynamicPart.length === 0) {
    return null;
  }
  if (anthropic && staticPart.length > 0) {
    return {
      role: "system",
      content: [
        { type: "text", text: staticPart, cacheControl: ANTHROPIC_CACHE },
        ...(dynamicPart.length > 0 ? [{ type: "text" as const, text: dynamicPart }] : []),
      ],
    };
  }
  return {
    role: "system",
    content: [staticPart, dynamicPart].filter((s) => s.length > 0).join("\n\n"),
  };
}

/**
 * One Chat Completions turn over OpenRouter (sdk.chat.send). Provider-agnostic out the top (returns
 * a {@link ChatTurnResult}, throws a {@link TurnError}), so domain/chat can inject it as a seam.
 * Caching is provider-aware: Anthropic models get a PER-BLOCK cache_control on the static system
 * block (pins the breakpoint at the stable prompt → reused across turns); everything else relies on
 * the provider's automatic caching. Cost + cached-token reads come back inline in usage.
 */
export async function runChatCompletionTurn(params: RawTurnParams): Promise<ChatTurnResult> {
  const startedAt = Date.now();
  const cfg = params.generation ?? {};
  const anthropic = isAnthropicModel(params.model);

  const systemMessage = buildChatSystemMessage(
    params.systemPrompt.static.trim(),
    params.systemPrompt.dynamic.trim(),
    anthropic,
  );
  const messages = [
    ...(systemMessage ? [systemMessage] : []),
    ...params.history
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content })),
  ];
  const chatProvider = effectiveProviderRouting(params.model, params.providerRouting);
  const reasoningEffort = toReasoningEffort(cfg);

  const chatRequest = {
    model: params.model,
    messages,
    ...chatSamplingFields(cfg),
    ...(reasoningEffort !== undefined ? { reasoning: { effort: reasoningEffort } } : {}),
    ...(chatProvider !== undefined ? { provider: chatProvider } : {}),
  };

  let view: ChatResultView;
  try {
    if (params.onDelta) {
      // Streaming mode: iterate the typed EventStream<ChatStreamChunk>. Each chunk carries:
      //   delta.content     → reply text (may be null when only reasoning arrives)
      //   delta.reasoning   → CoT thinking from extended-thinking models (e.g. claude-3-7-sonnet
      //                       extended thinking, o3-mini) — shown separately in the UI
      //   chunk.error       → in-band provider error (code + message); treat as a thrown TurnError
      //   chunk.usage       → ONLY present on the final [DONE] sentinel chunk (after all deltas)
      //   choices[0].finishReason → also only set on the sentinel
      const stream = await getOpenRouterClient(params.openRouterApiKey).chat.send({
        chatRequest: { ...chatRequest, stream: true },
      } as Parameters<OpenRouter["chat"]["send"]>[0] & { chatRequest: { stream: true } });
      let replyText = "";
      let _reasoningText = "";
      let usage: ChatResultView["usage"];
      let finishReason: string | null = null;
      for await (const chunk of stream as AsyncIterable<{
        choices: Array<{
          delta: { content?: string | null; reasoning?: string | null };
          finishReason: string | null;
        }>;
        error?: { code: number; message: string } | null;
        usage?: ChatResultView["usage"];
      }>) {
        // In-band error: OpenRouter can embed an error object mid-stream (e.g. billing / rate-limit).
        // Map it through mapOpenRouterError so the kind/retryable surface is consistent.
        if (chunk.error != null) {
          const syntheticErr = Object.assign(new Error(chunk.error.message), {
            statusCode: chunk.error.code,
          });
          throw syntheticErr;
        }
        const delta = chunk.choices[0]?.delta;
        if (delta) {
          if (typeof delta.content === "string" && delta.content.length > 0) {
            replyText += delta.content;
            params.onDelta({ chatId: params.chatId ?? "", kind: "text", text: delta.content });
          }
          if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
            _reasoningText += delta.reasoning;
            params.onDelta({
              chatId: params.chatId ?? "",
              kind: "reasoning",
              text: delta.reasoning,
            });
          }
        }
        // usage is only present on the sentinel chunk
        if (chunk.usage !== undefined) usage = chunk.usage;
        if (chunk.choices[0]?.finishReason) finishReason = chunk.choices[0].finishReason;
      }
      view = {
        choices: [{ finishReason, message: { content: replyText } }],
        ...(usage !== undefined ? { usage } : {}),
      };
    } else {
      const result = await getOpenRouterClient(params.openRouterApiKey).chat.send({
        chatRequest,
      } as Parameters<OpenRouter["chat"]["send"]>[0]);
      view = result as unknown as ChatResultView;
    }
  } catch (error) {
    const mapped = mapOpenRouterError(error, params.model, "chat");
    getLog().error(
      {
        model: params.model,
        status: mapped.apiErrorStatus,
        kind: mapped.kind,
        retryable: mapped.retryable,
        err: mapped.message,
      },
      "openrouter: chat turn failed",
    );
    throw mapped;
  }

  const u = view.usage;
  const uCostDetails = u?.costDetails;
  const usage: ChatTurnUsage = {
    model: params.model,
    tokensIn: u?.promptTokens ?? 0,
    tokensOut: u?.completionTokens ?? 0,
    cacheReadTokens: u?.promptTokensDetails?.cachedTokens ?? 0,
    cacheWriteTokens: u?.promptTokensDetails?.cacheWriteTokens ?? 0,
    // The 5m/1h split is Anthropic/sdk-internal — openrouter can't report it → null (NA, not 0).
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
    reasoningTokens: u?.completionTokensDetails?.reasoningTokens ?? null,
    contextWindow: await lookupContextWindow(params.model),
    maxOutputTokens: cfg.maxOutputTokens ?? null, // echo the requested cap; null if none asked
    webSearchRequests: 0, // chat-completions path has no tool-call reporting
    costUsd: u?.cost ?? 0,
    costDetails:
      uCostDetails != null
        ? {
            totalUsd: uCostDetails.upstreamInferenceCost ?? 0,
            promptUsd: uCostDetails.upstreamInferencePromptCost ?? 0,
            completionUsd: uCostDetails.upstreamInferenceCompletionsCost ?? 0,
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
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - startedAt,
    },
    "openrouter: chat turn complete",
  );

  const chatFinish = view.choices?.[0]?.finishReason ?? null;
  return {
    reply: extractChatReply(view),
    sessionId: "", // the openrouter runner has no SDK session — history is rebuilt from canon
    stopReason: chatFinish,
    terminalReason: null,
    finishReason: normalizeFinishReason(chatFinish),
    ttftMs: null,
    durationApiMs: Date.now() - startedAt,
    apiErrorStatus: null,
    numTurns: 1,
    usage,
    events: [],
    rateLimit: null,
  };
}
