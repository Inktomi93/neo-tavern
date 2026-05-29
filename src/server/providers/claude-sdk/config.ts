import {
  type EffortLevel,
  type Options,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { type GenerationParams, isThinkingOn } from "../../../shared/generation";
import { getAppConfig } from "../../config/app-config";
import {
  buildClaudeOpenRouterEnv,
  buildClaudeSdkEnv,
  type ClaudeGenerationOverrides,
} from "../../env";
import { getLog } from "../../observability/logger";
import type { ClaudeSource } from "./types";

// `openRouterApiKey` is the resolved key for mode 2 (source=openrouter — the Anthropic skin); the
// caller (runChatTurn, fed by the turn-time resolver) supplies it. mode 1 (max-pro-sub) ignores it
// and authenticates via the host `claude login`. No env read here — the key arrives resolved.
export function disciplineOptions(
  source: ClaudeSource = "max-pro-sub",
  overrides: ClaudeGenerationOverrides = {},
  openRouterApiKey?: string,
) {
  return {
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    env:
      source === "openrouter"
        ? buildClaudeOpenRouterEnv(openRouterApiKey ?? "", overrides)
        : buildClaudeSdkEnv(overrides),
  };
}

// Opt-in subprocess observability. When LOG_LEVEL is debug/trace we enable the
// SDK's own `--debug` instrumentation (this is what exposes plugin/hook injection
// — "Registered N hooks from M plugins"; with our config it proves 0/0) and pipe
// the raw subprocess stderr into the request logger. Both emit METADATA only
// (endpoints, request ids, source) — never the assembled prompt or reply (see
// docs/sdk-notes.md "Observing injection"). Kept OUT of disciplineOptions() so
// that helper stays the pure leak contract the tests lock.
export function observabilityOptions(): Partial<Options> {
  const logLevel = getAppConfig().logLevel;
  if (logLevel !== "debug" && logLevel !== "trace") {
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
export function buildSystemPrompt(
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
// Translate the unified GenerationParams into the agent-sdk's native surface: typed Options
// (thinking/effort/maxBudgetUsd) for the things the SDK types directly, plus env overrides for the
// rest (output cap; thinking-disable, the owner default). effort/thinking only apply when thinking
// is on (the SDK ignores effort otherwise). temperature/topP have no agent-sdk knob → dropped.
export function toSdkGeneration(generation: GenerationParams | undefined): {
  envOverrides: ClaudeGenerationOverrides;
  options: { thinking?: ThinkingConfig; effort?: EffortLevel; maxBudgetUsd?: number };
} {
  const g = generation ?? {};
  const thinkingOn = isThinkingOn(g);
  const options: { thinking?: ThinkingConfig; effort?: EffortLevel; maxBudgetUsd?: number } = {};
  if (thinkingOn) {
    options.thinking =
      g.thinkingBudgetTokens !== undefined
        ? { type: "enabled", budgetTokens: g.thinkingBudgetTokens }
        : { type: "adaptive" };
    if (g.effort !== undefined) {
      options.effort = g.effort; // model-gated; the SDK clamps unsupported levels
    }
  }
  if (g.maxBudgetUsd !== undefined) {
    options.maxBudgetUsd = g.maxBudgetUsd;
  }
  // Compaction: "off" AND "managed" both disable the SDK's auto-compaction (managed = WE fire a
  // steered /compact via the domain layer; off = manual only). "auto" leaves it on, with
  // thresholdPct → the percent-of-window override when set.
  const mode = g.compaction?.mode;
  const disableAutoCompact = mode === "off" || mode === "managed";
  const autoCompactPct =
    mode === "auto" && g.compaction?.thresholdPct !== undefined
      ? Math.round(g.compaction.thresholdPct * 100)
      : undefined;
  return {
    envOverrides: {
      maxOutputTokens: g.maxOutputTokens,
      disableThinking: !thinkingOn,
      disableAutoCompact: disableAutoCompact ? true : undefined,
      autoCompactPct,
    },
    options,
  };
}

// async (not a bare Promise-returning fn) so a synchronous throw from query() (e.g. bad
// options) surfaces as a rejected promise, not a sync throw at the call site.
