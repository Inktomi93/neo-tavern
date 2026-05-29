import { describe, expect, test } from "vitest";
import { toSdkGeneration } from "./claude-sdk";
import { chatSamplingFields, toReasoningEffort } from "./openrouter";

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

  test("compaction off/managed → disableAutoCompact; auto+threshold → autoCompactPct (fraction→percent)", () => {
    // Both "off" and "managed" disable the SDK's auto-compaction (managed = WE drive /compact).
    expect(toSdkGeneration({ compaction: { mode: "off" } }).envOverrides.disableAutoCompact).toBe(
      true,
    );
    const managed = toSdkGeneration({ compaction: { mode: "managed", thresholdPct: 0.9 } });
    expect(managed.envOverrides.disableAutoCompact).toBe(true);
    expect(managed.envOverrides.autoCompactPct).toBeUndefined(); // managed doesn't use the SDK override

    const auto = toSdkGeneration({ compaction: { mode: "auto", thresholdPct: 0.85 } });
    expect(auto.envOverrides.disableAutoCompact).toBeUndefined();
    expect(auto.envOverrides.autoCompactPct).toBe(85); // auto tunes the SDK's own threshold

    // default (no compaction config) leaves auto-compaction alone
    expect(toSdkGeneration({}).envOverrides.disableAutoCompact).toBeUndefined();
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

describe("openrouter chat sampling translation (chatSamplingFields)", () => {
  test("empty params → no sampler fields", () => {
    expect(chatSamplingFields({})).toEqual({});
  });

  test("maxOutputTokens maps to the SDK's maxCompletionTokens field", () => {
    expect(chatSamplingFields({ maxOutputTokens: 256 })).toEqual({ maxCompletionTokens: 256 });
  });

  test("maps every sampler to its SDK field name; unset knobs are omitted", () => {
    expect(
      chatSamplingFields({
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 512,
        frequencyPenalty: 0.5,
        presencePenalty: 0.3,
        repetitionPenalty: 1.1,
        seed: 42,
        logitBias: { "123": -5 },
        stop: ["\n\n", "END"],
      }),
    ).toEqual({
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      maxCompletionTokens: 512,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3,
      repetitionPenalty: 1.1,
      seed: 42,
      logitBias: { "123": -5 },
      stop: ["\n\n", "END"],
    });
  });
});
