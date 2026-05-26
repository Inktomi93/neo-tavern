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
  /** result.session_id — persist on the chat row so the next turn resumes it (sdk-mode; "" for raw). */
  sessionId: string;
  stopReason: string | null;
  terminalReason: TerminalReason | null;
  /** Time-to-first-token (ms), when reported. */
  ttftMs: number | null;
  /** Non-null when transient API errors occurred but retries recovered the turn. */
  apiErrorStatus: number | null;
  numTurns: number;
  usage: ChatTurnUsage;
  /** Compaction / retry / rate-limit / status / auth events seen this turn (metadata; sdk-mode). */
  events: TurnEvent[];
  /** Latest rate-limit snapshot seen this turn, if any. */
  rateLimit: RateLimitSnapshot | null;
}
