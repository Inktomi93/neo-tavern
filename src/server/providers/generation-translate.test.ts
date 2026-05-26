import { describe, expect, test } from "vitest";
import { toSdkGeneration } from "./claude-sdk";
import { toReasoningEffort } from "./openrouter";

// Locks the provider-agnostic GenerationParams → native-surface translation for both runners (the
// "one vocab, each runner translates" contract). Pure functions; no network/model.

describe("agent-sdk generation translation (toSdkGeneration)", () => {
  test("default (no knobs): thinking disabled via env, no typed reasoning options", () => {
    const { envOverrides, options } = toSdkGeneration({});
    expect(envOverrides.disableThinking).toBe(true);
    expect(options.thinking).toBeUndefined();
    expect(options.effort).toBeUndefined();
  });

  test("adaptive thinking → typed adaptive option + thinking enabled in env", () => {
    const { envOverrides, options } = toSdkGeneration({ thinking: "adaptive", effort: "high" });
    expect(envOverrides.disableThinking).toBe(false);
    expect(options.thinking).toEqual({ type: "adaptive" });
    expect(options.effort).toBe("high");
  });

  test("a fixed budget → enabled thinking with budgetTokens", () => {
    const { options } = toSdkGeneration({ thinkingBudgetTokens: 4096 });
    expect(options.thinking).toEqual({ type: "enabled", budgetTokens: 4096 });
  });

  test("effort is dropped when thinking is off (the SDK ignores it anyway)", () => {
    const { envOverrides, options } = toSdkGeneration({ thinking: "off", effort: "max" });
    expect(envOverrides.disableThinking).toBe(true);
    expect(options.effort).toBeUndefined();
  });

  test("maxOutputTokens → env override; maxBudgetUsd → typed option", () => {
    const { envOverrides, options } = toSdkGeneration({
      maxOutputTokens: 1024,
      maxBudgetUsd: 0.25,
    });
    expect(envOverrides.maxOutputTokens).toBe(1024);
    expect(options.maxBudgetUsd).toBe(0.25);
  });
});

describe("openrouter reasoning translation (toReasoningEffort)", () => {
  test("no reasoning preference → undefined (model/provider default)", () => {
    expect(toReasoningEffort({})).toBeUndefined();
    expect(toReasoningEffort(undefined)).toBeUndefined();
  });

  test("thinking off → 'none' (disable reasoning)", () => {
    expect(toReasoningEffort({ thinking: "off" })).toBe("none");
    expect(toReasoningEffort({ thinking: "off", effort: "high" })).toBe("none");
  });

  test("effort passes through; the Claude-only 'max' maps to 'xhigh' (OpenRouter has no max)", () => {
    expect(toReasoningEffort({ effort: "high" })).toBe("high");
    expect(toReasoningEffort({ effort: "max" })).toBe("xhigh");
  });

  test("thinking on without an explicit effort defaults to 'high'", () => {
    expect(toReasoningEffort({ thinking: "adaptive" })).toBe("high");
  });
});
