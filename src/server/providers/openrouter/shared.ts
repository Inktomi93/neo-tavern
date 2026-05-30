import type { ChatDeltaEvent } from "../../../shared/chat-types";
import { type GenerationParams, isThinkingOn } from "../../../shared/generation";
import type { OpenRouterProviderRouting } from "../../../shared/provider-routing";
import { TurnError, type TurnErrorKind } from "../turn";
import { listOpenRouterModels } from "./catalog";

// ── Shared turn params + error mapping ─────────────────────────────────────────

export interface RawTurnParams {
  /** OpenRouter "provider/model" id. */
  model: string;
  /** The resolved OpenRouter API key for THIS turn (per-user BYO or the host fallback) — selects the
   *  per-key client (§9). Supplied by the verbs after resolveCredential; a per-user key never leaks
   *  into another user's client. */
  openRouterApiKey: string;
  /** Chat id — carried through so the onDelta emitter can tag events with the originating chat. */
  chatId?: string | undefined;
  /** Assembled system prompt; static is the cache-stable prefix, dynamic the per-turn suffix. */
  systemPrompt: { static: string; dynamic: string };
  /** Full conversation from canon, oldest→newest (the last entry is the new user message). */
  history: { role: "user" | "assistant"; content: string }[];
  /** The unified generation knobs (shared/generation.ts). temperature/topP/maxOutputTokens map to
   *  request fields; thinking/effort → the `reasoning` block; maxBudgetUsd is a no-op here (no
   *  per-request budget). undefined = the model/provider defaults. */
  generation?: GenerationParams | undefined;
  /** OpenRouter provider-routing preferences (order/allowFallbacks/sort/only/ignore/…). Lenient
   *  pass-through (OpenRouter owns the schema); undefined = default routing. From chats.metadata. */
  providerRouting?: OpenRouterProviderRouting | undefined;
  /** Streaming delta callback — fires once per token chunk, discriminated by kind (text|reasoning).
   *  Text chunks are the reply content; reasoning chunks are CoT thinking from extended-thinking
   *  models (e.g. claude-3-7-sonnet with thinking on, or o3-mini). Each should render separately. */
  onDelta?: (event: ChatDeltaEvent) => void;
}

// OpenRouter usage doesn't report the model's context window — backfill it from the cached catalog
// (contextLength) so the context-fill meter works on openrouter chats too, instead of a null/0 hole.
// Best-effort: a catalog miss or fetch failure → null (genuinely unknown), never a thrown turn.
export async function lookupContextWindow(model: string): Promise<number | null> {
  try {
    const models = await listOpenRouterModels();
    return models.find((m) => m.id === model)?.contextLength ?? null;
  } catch {
    return null;
  }
}

// Translate the unified reasoning knobs into OpenRouter's `reasoning.effort`. "off" → "none"
// (disables reasoning on reasoning models); otherwise the effort level, with the agnostic "max"
// (Claude-only) mapped to "xhigh" (OpenRouter's enum has no "max"). undefined = no preference.
// A fixed thinking budget has no OpenRouter chat equivalent, so it's treated as "on" (effort only).
export function toReasoningEffort(generation: GenerationParams | undefined): string | undefined {
  const g = generation ?? {};
  if (g.thinking === "off") {
    return "none";
  }
  if (!isThinkingOn(g)) {
    return undefined;
  }
  return g.effort === "max" ? "xhigh" : (g.effort ?? "high");
}

// Map the unified sampling knobs → @openrouter/sdk chat-completions request fields. Conditional
// spreads keep each field precisely typed (so the request stays assignable to `chat.send`) and omit
// unset knobs entirely. Reasoning + provider routing are added separately by the caller. Pure +
// exported so the mapping is unit-tested without a live client.
export function chatSamplingFields(g: GenerationParams) {
  return {
    ...(g.temperature !== undefined ? { temperature: g.temperature } : {}),
    ...(g.topP !== undefined ? { topP: g.topP } : {}),
    ...(g.topK !== undefined ? { topK: g.topK } : {}),
    ...(g.maxOutputTokens !== undefined ? { maxCompletionTokens: g.maxOutputTokens } : {}),
    ...(g.frequencyPenalty !== undefined ? { frequencyPenalty: g.frequencyPenalty } : {}),
    ...(g.presencePenalty !== undefined ? { presencePenalty: g.presencePenalty } : {}),
    ...(g.repetitionPenalty !== undefined ? { repetitionPenalty: g.repetitionPenalty } : {}),
    ...(g.seed !== undefined ? { seed: g.seed } : {}),
    ...(g.logitBias !== undefined ? { logitBias: g.logitBias } : {}),
    ...(g.stop !== undefined ? { stop: g.stop } : {}),
  };
}

// Map @openrouter/sdk errors → our provider-agnostic kinds. Response errors carry a numeric
// statusCode; transport errors (connection/timeout/abort) carry a name.
export function mapOpenRouterError(error: unknown, model: string, endpoint: string): TurnError {
  const status =
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : undefined;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  // Exhaustive over the status codes the OpenRouter spec documents (400/401/402/403/404/408/413/
  // 422/429/500/502/503) → our provider-agnostic TurnErrorKind; transport-level failures fall back
  // to name/message heuristics; anything else is `unknown`.
  let kind: TurnErrorKind;
  let retryable: boolean;
  if (status === 401 || status === 403) {
    // 401 = bad/missing key; 403 = insufficient perms OR a guardrail block. Non-retryable either way.
    kind = "auth_failed";
    retryable = false;
  } else if (status === 402) {
    kind = "billing";
    retryable = false;
  } else if (status === 404) {
    kind = "model_unavailable";
    retryable = false;
  } else if (status === 429) {
    kind = "rate_limit";
    retryable = true;
  } else if (status === 400 || status === 413 || status === 422) {
    kind = "invalid";
    retryable = false;
  } else if (status === 408 || (status !== undefined && status >= 500)) {
    // 408 Request Timeout + 5xx (500 internal / 502 bad gateway / 503 unavailable) — all transient.
    kind = "server";
    retryable = true;
  } else if (/timeout|connection|network|overload/i.test(`${name} ${message}`)) {
    kind = "server";
    retryable = true;
  } else if (/abort/i.test(name)) {
    kind = "aborted";
    retryable = false;
  } else {
    kind = "unknown";
    retryable = false;
  }
  return new TurnError({
    kind,
    retryable,
    message: `openrouter ${endpoint} (${model}): ${message}`,
    ...(status !== undefined ? { apiErrorStatus: status } : {}),
    cause: error,
  });
}

/** Join the assembled static + dynamic halves into one system string (the simple, cross-provider
 *  shape). Finer-grained static/history cache breakpoints are a later refinement (#48). */
export function joinSystemPrompt(sp: { static: string; dynamic: string }): string {
  return [sp.static, sp.dynamic]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}
