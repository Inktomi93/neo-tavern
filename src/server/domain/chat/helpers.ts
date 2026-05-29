import type { AssembleContext, AssembledPrompt } from "../../../shared/prompt-assemble";
import type { ChatTurnResult, TurnError } from "../../providers/turn";
import type { MessageView, SendResult } from "./types";

/**
 * Maps a TurnError into a typed SendResult error state.
 */
export function buildTurnErrorResult(
  error: TurnError,
  messages: MessageView[],
): SendResult & { status: "error" } {
  return {
    status: "error",
    code: error.kind,
    retryable: error.retryable,
    ...(error.resetsAt !== undefined ? { resetsAt: error.resetsAt } : {}),
    messages,
  };
}

/**
 * Extracts the identical provenance columns from a ChatTurnResult for inserting or updating a messages row.
 * Used by send, swipe, and lifecycle to avoid duplicating 15+ column mappings.
 */
export function buildTurnProvenance(
  turn: ChatTurnResult,
  provider: string,
  reasoningEffort: string | null | undefined,
) {
  return {
    content: turn.reply,
    model: turn.usage.model,
    provider,
    stopReason: turn.stopReason,
    finishReason: turn.finishReason,
    reasoningEffort: reasoningEffort ?? null,
    tokensIn: turn.usage.tokensIn,
    tokensOut: turn.usage.tokensOut,
    cacheReadTokens: turn.usage.cacheReadTokens,
    cacheWriteTokens: turn.usage.cacheWriteTokens,
    cacheCreation5mTokens: turn.usage.cacheCreation5mTokens,
    cacheCreation1hTokens: turn.usage.cacheCreation1hTokens,
    contextWindow: turn.usage.contextWindow,
    maxOutputTokens: turn.usage.maxOutputTokens,
    ttftMs: turn.ttftMs,
    terminalReason: turn.terminalReason,
    apiErrorStatus: turn.apiErrorStatus,
    costUsd: turn.usage.costUsd,
  };
}

/**
 * Builds the prompt trace metadata object — the same shape logged by send() and returned by
 * previewAssembly(). Keeping this in one place means adding a new trace field only touches helpers.ts.
 */
export function buildPromptTrace(
  systemPrompt: AssembledPrompt,
  assembleCtx: AssembleContext,
): {
  staticChars: number;
  dynamicChars: number;
  staticSections: string[];
  dynamicSections: string[];
  worldInfoAttached: number;
  worldInfoIncluded: number;
  matchedKeys: string[];
  hasPersona: boolean;
} {
  return {
    staticChars: systemPrompt.static.length,
    dynamicChars: systemPrompt.dynamic.length,
    staticSections: systemPrompt.trace.staticSections,
    dynamicSections: systemPrompt.trace.dynamicSections,
    worldInfoAttached: assembleCtx.worldEntries.length,
    worldInfoIncluded: systemPrompt.trace.worldInfoIncluded,
    matchedKeys: systemPrompt.trace.matchedKeys,
    hasPersona: assembleCtx.activePersona !== null,
  };
}
