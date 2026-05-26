import { describe, expect, test } from "vitest";
import { generationParamsSchema, isThinkingOn } from "./generation";

describe("generation params vocabulary", () => {
  test("empty parses to {} (all knobs optional, no defaults forced)", () => {
    expect(generationParamsSchema.parse({})).toEqual({});
  });

  test("accepts the full knob set and rejects out-of-range / unknown values", () => {
    const ok = generationParamsSchema.parse({
      temperature: 0.8,
      topP: 0.9,
      maxOutputTokens: 2048,
      thinking: "adaptive",
      thinkingBudgetTokens: 4000,
      effort: "xhigh",
      maxBudgetUsd: 0.5,
    });
    expect(ok.effort).toBe("xhigh");

    expect(() => generationParamsSchema.parse({ temperature: 3 })).toThrow();
    expect(() => generationParamsSchema.parse({ effort: "ludicrous" })).toThrow();
    expect(() => generationParamsSchema.parse({ maxOutputTokens: 0 })).toThrow();
  });

  test("isThinkingOn: off wins; adaptive / budget / effort each turn it on; bare params is off", () => {
    expect(isThinkingOn({})).toBe(false);
    expect(isThinkingOn({ thinking: "off" })).toBe(false);
    expect(isThinkingOn({ thinking: "adaptive" })).toBe(true);
    expect(isThinkingOn({ thinkingBudgetTokens: 2000 })).toBe(true);
    expect(isThinkingOn({ effort: "high" })).toBe(true);
    // explicit off beats an effort/budget that would otherwise enable it
    expect(isThinkingOn({ thinking: "off", effort: "high" })).toBe(false);
  });
});
