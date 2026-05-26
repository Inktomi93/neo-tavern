import { describe, expect, test } from "vitest";
import { normalizeFinishReason } from "./turn";

// One normalized vocabulary across every provider dialect (Anthropic stop_reason, OpenAI
// finish_reason, the Responses status/incomplete reason) — so a query isn't mode-dependent.
describe("normalizeFinishReason", () => {
  test("natural completion → stop (across all three dialects)", () => {
    expect(normalizeFinishReason("end_turn")).toBe("stop"); // Anthropic
    expect(normalizeFinishReason("stop")).toBe("stop"); // OpenAI chat
    expect(normalizeFinishReason("completed")).toBe("stop"); // Responses status
    expect(normalizeFinishReason("stop_sequence")).toBe("stop");
  });

  test("output/context ceiling → length", () => {
    expect(normalizeFinishReason("max_tokens")).toBe("length"); // Anthropic
    expect(normalizeFinishReason("length")).toBe("length"); // OpenAI chat
    expect(normalizeFinishReason("max_output_tokens")).toBe("length"); // Responses incomplete reason
  });

  test("filter / tool", () => {
    expect(normalizeFinishReason("content_filter")).toBe("filter");
    expect(normalizeFinishReason("refusal")).toBe("filter");
    expect(normalizeFinishReason("tool_use")).toBe("tool"); // Anthropic
    expect(normalizeFinishReason("tool_calls")).toBe("tool"); // OpenAI
  });

  test("case-insensitive; null/empty → null; unknown → other", () => {
    expect(normalizeFinishReason("END_TURN")).toBe("stop");
    expect(normalizeFinishReason(null)).toBeNull();
    expect(normalizeFinishReason(undefined)).toBeNull();
    expect(normalizeFinishReason("")).toBeNull();
    expect(normalizeFinishReason("something_new")).toBe("other");
  });
});
