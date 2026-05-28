import type {
  SDKAssistantMessageError,
  SDKRateLimitInfo,
  SDKResultError,
  SDKStatus,
  TerminalReason,
} from "@anthropic-ai/claude-agent-sdk";

// ── The PROVIDER-AGNOSTIC turn contract ──────────────────────────────────────
// The shared shape both providers speak: sdk-mode (claude-sdk.ts) and raw-mode
// (openrouter.ts) each produce a `ChatTurnResult` and throw a `TurnError`, so the
// transport + UI key off ONE vocabulary and the error surface is never re-derived
// per provider. It lives here (not in claude-sdk.ts) so openrouter.ts doesn't import
// from a Claude-named module. Some fields are typed with the Agent SDK's enums —
// those enums ARE the canonical vocabulary (e.g. terminal/rate-limit states); the
// raw adapter populates the subset it has and leaves the SDK-only side details unset.

// `kind` is the public failure surface every provider maps its errors onto.
export type TurnErrorKind =
  | "rate_limit" // allowance exhausted — retryable once it resets
  | "auth_failed" // credential rejected — the ban-risk canary; NOT retryable, alert loudly
  | "billing" // out of budget / billing problem
  | "invalid" // malformed request — a bug on our side
  | "model_unavailable" // unknown/unsupported model
  | "server" // upstream 5xx / execution error — transient, retryable
  | "max_output" // hit the output-token ceiling mid-reply — retry can continue
  | "aborted" // turn-limit / abort
  | "unknown";

// ── Normalized finish reason (the cross-mode "why did generation stop?" vocabulary) ──────────────
// Each provider speaks its own dialect — Anthropic stop_reason (end_turn/max_tokens/…), OpenAI
// finish_reason (stop/length/…), the Responses status/incomplete_details — so a raw value isn't
// queryable across modes. `finishReason` on the result is the ONE normalized signal; the raw value
// rides along on `stopReason`/`terminalReason` as provenance. `normalizeFinishReason` is the single
// owner of the mapping (every runner calls it).
export type NormalizedFinishReason =
  | "stop" // natural completion
  | "length" // hit the output-token / context ceiling (the "truncated" case)
  | "filter" // content filter / refusal
  | "tool" // stopped to call a tool
  | "other"; // a provider value we don't (yet) recognize

const FINISH_REASON_MAP: Record<string, NormalizedFinishReason> = {
  end_turn: "stop",
  stop: "stop",
  stop_sequence: "stop",
  completed: "stop",
  max_tokens: "length",
  length: "length",
  max_output_tokens: "length",
  model_context_window_exceeded: "length",
  content_filter: "filter",
  refusal: "filter",
  tool_use: "tool",
  tool_calls: "tool",
  function_call: "tool",
};

/** Map any provider's raw stop/finish/status string → the normalized vocabulary. null in → null
 *  out; an unrecognized non-null value → "other" (so it's never silently a stop). */
export function normalizeFinishReason(
  raw: string | null | undefined,
): NormalizedFinishReason | null {
  if (raw == null || raw === "") {
    return null;
  }
  return FINISH_REASON_MAP[raw.toLowerCase()] ?? "other";
}

export interface TurnErrorInit {
  kind: TurnErrorKind;
  retryable: boolean;
  message: string;
  /** Raw SDK assistant-error code, when the failure came from the Agent SDK. */
  sdkError?: SDKAssistantMessageError;
  /** Raw SDK result error subtype, when the failure was an SDK error result. */
  resultSubtype?: SDKResultError["subtype"];
  /** For rate_limit: epoch ms when the window resets. */
  resetsAt?: number;
  /** The upstream HTTP status that produced this error, when one applies (raw/OpenRouter path).
   *  Captured so every failure's status is curl-able via /api/_debug, not just the mapped `kind`. */
  apiErrorStatus?: number;
  cause?: unknown;
}

/** The provider-agnostic turn failure. Named `TurnError` (not `ClaudeTurnError`) because
 *  raw-mode/OpenRouter throws it too — the `sdkError`/`resultSubtype` side details are just
 *  unset there. */
export class TurnError extends Error {
  readonly kind: TurnErrorKind;
  readonly retryable: boolean;
  readonly sdkError: SDKAssistantMessageError | undefined;
  readonly resultSubtype: SDKResultError["subtype"] | undefined;
  readonly resetsAt: number | undefined;
  readonly apiErrorStatus: number | undefined;

  constructor(init: TurnErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "TurnError";
    this.kind = init.kind;
    this.retryable = init.retryable;
    this.sdkError = init.sdkError;
    this.resultSubtype = init.resultSubtype;
    this.resetsAt = init.resetsAt;
    this.apiErrorStatus = init.apiErrorStatus;
  }
}

// ── Per-turn structured events ───────────────────────────────────────────────
// Everything the stream tells us BESIDES the reply text + final usage. Metadata only
// (never RP content). Returned on ChatTurnResult.events AND logged live, so a long chat's
// auto-compaction, transient retries, and rate-limit warnings are observable via
// /api/_debug without scanning the model's output. (SDK-mode populates these; raw-mode
// returns [] — its transient events are mapped to a thrown TurnError instead.)
export interface RateLimitSnapshot {
  status: SDKRateLimitInfo["status"];
  rateLimitType: SDKRateLimitInfo["rateLimitType"];
  resetsAt: number | undefined;
  utilization: number | undefined;
  /** True when the account is consuming overage beyond the subscription limit.
   *  This is the ban-risk canary — surface loudly in the UI when true. */
  isUsingOverage: boolean | undefined;
  /** The threshold fraction (0–1) that was crossed to trigger this event (e.g. 0.75). */
  surpassedThreshold: number | undefined;
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

export interface CostDetails {
  /** Total upstream inference cost (= promptUsd + completionUsd). */
  totalUsd: number;
  /** Prompt/input portion of the upstream cost. */
  promptUsd: number;
  /** Completion/output portion of the upstream cost. */
  completionUsd: number;
}

export interface ChatTurnUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // The fields below are `| null` where a runner genuinely can't report them — null means
  // "not available in this mode," distinct from a real 0, so cross-mode filtering/analytics stay
  // honest (a null contextWindow ≠ a 0-token window). agent-sdk reports all of them; the openrouter
  // runner backfills contextWindow from the catalog and leaves the Anthropic-only cache split null.
  /** Cache-creation tokens by TTL bucket (usage.cache_creation) — Anthropic/sdk only; null on openrouter. */
  cacheCreation5mTokens: number | null;
  cacheCreation1hTokens: number | null;
  /** Tokens used for CoT reasoning/thinking (chat: completionTokensDetails.reasoningTokens;
   *  responses: outputTokensDetails.reasoningTokens). null when the path doesn't report it. */
  reasoningTokens: number | null;
  /** Model context window — drives the context-fill meter. sdk reports it; openrouter backfills from
   *  the catalog `contextLength` (null if the model isn't in the catalog). */
  contextWindow: number | null;
  /** Output ceiling. sdk reports the effective cap; openrouter echoes the requested cap (else null). */
  maxOutputTokens: number | null;
  /** Number of web-search tool calls this turn (sdk-mode only; 0 in our locked config). */
  webSearchRequests: number;
  costUsd: number;
  /** Per-phase cost breakdown (prompt vs. completion) from OpenRouter usage.costDetails.
   *  null on sdk-mode (costUSD is total; Anthropic doesn't split it). */
  costDetails: CostDetails | null;
  /** True when this turn was billed against a BYOK (Bring Your Own Key) credential rather
   *  than our OpenRouter credits. Changes cost interpretation. */
  isByok: boolean | null;
}

export interface ChatTurnResult {
  reply: string;
  /** result.session_id — persist on the chat row so the next turn resumes it (sdk-mode; "" for raw). */
  sessionId: string;
  /** Raw provider stop string (Anthropic stop_reason / OpenAI finish_reason) — provenance. */
  stopReason: string | null;
  terminalReason: TerminalReason | null;
  /** The NORMALIZED cross-mode finish reason (see normalizeFinishReason) — query this, not the raw. */
  finishReason: NormalizedFinishReason | null;
  /** Time-to-first-token (ms), when reported. */
  ttftMs: number | null;
  /** API-only duration in ms (excludes subprocess spawn overhead). sdk: result.duration_api_ms;
   *  openrouter: wall-clock from request start to last chunk. null if not available. */
  durationApiMs: number | null;
  /** Non-null when transient API errors occurred but retries recovered the turn. */
  apiErrorStatus: number | null;
  numTurns: number;
  usage: ChatTurnUsage;
  /** Compaction / retry / rate-limit / status / auth events seen this turn (metadata; sdk-mode). */
  events: TurnEvent[];
  /** Latest rate-limit snapshot seen this turn, if any. */
  rateLimit: RateLimitSnapshot | null;
}
