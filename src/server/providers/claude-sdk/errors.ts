import type { SDKAssistantMessageError, SDKResultError } from "@anthropic-ai/claude-agent-sdk";
import type { TurnErrorKind } from "../turn";

// The provider-agnostic turn contract (TurnError/TurnErrorKind/TurnEvent/ChatTurnResult/…) lives
// in ./turn so raw-mode can throw + return the same shapes without importing this Claude module.
// The classification below maps the Agent SDK's own error codes onto that shared TurnErrorKind.

// Exhaustive over SDKAssistantMessageError (no default → tsc flags a new SDK code).
export function classifyAssistantError(code: SDKAssistantMessageError): {
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
export function classifyResultSubtype(subtype: SDKResultError["subtype"]): {
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
