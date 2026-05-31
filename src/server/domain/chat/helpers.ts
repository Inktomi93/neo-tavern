import type { AssembleContext, AssembledPrompt } from "../../../shared/prompt-assemble";
import { estimateTokens } from "../../../shared/tokens";
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
  staticTokens: number;
  dynamicTokens: number;
  staticSections: string[];
  dynamicSections: string[];
  worldInfoAttached: number;
  worldInfoIncluded: number;
  matchedKeys: string[];
  hasPersona: boolean;
  staticCacheBusters: string[];
} {
  return {
    // Generic QuadChars token estimate (shared/tokens.ts) — replaces the old raw char counts as the
    // prompt-size metric. Advisory, not billing truth (that's the provider `usage`). Cheap to
    // compute here; surfaces in the send log + the read() trace.
    staticTokens: estimateTokens(systemPrompt.static),
    dynamicTokens: estimateTokens(systemPrompt.dynamic),
    staticSections: systemPrompt.trace.staticSections,
    dynamicSections: systemPrompt.trace.dynamicSections,
    worldInfoAttached: assembleCtx.worldEntries.length,
    worldInfoIncluded: systemPrompt.trace.worldInfoIncluded,
    matchedKeys: systemPrompt.trace.matchedKeys,
    hasPersona: assembleCtx.activePersona !== null,
    // {{random}}/{{date}}/etc found in static-half source templates — they re-resolve every turn,
    // busting the cached prefix. Empty in the well-formed case; non-empty = warn the operator.
    staticCacheBusters: systemPrompt.trace.staticCacheBusters,
  };
}
