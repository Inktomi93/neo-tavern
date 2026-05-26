import { describe, expect, test } from "vitest";
import { type AssembleContext, assemblePrompt } from "./prompt-assemble";
import { promptConfigSchema } from "./prompt-config";

// Minimal context: a character + the optional compactSummary the marker reads.
function ctx(compactSummary: string | null): AssembleContext {
  return {
    character: { name: "Probe", description: "a test character" },
    worldEntries: [],
    recentMessages: [],
    compactSummary,
  };
}

// A config whose only section is the {{compact_summary}} marker (defaults filled by the schema).
const config = promptConfigSchema.parse({
  schemaVersion: 1,
  sections: [{ type: "marker", id: "cs", name: "Summary", marker: "compact_summary" }],
  params: {},
});

describe("compact_summary marker", () => {
  test("renders the chat's summary and flags the trace when present", () => {
    const result = assemblePrompt(config, ctx("Alice and Bob agreed to meet at dawn."));

    expect(result.static).toContain("Alice and Bob agreed to meet at dawn.");
    expect(result.trace.compactSummaryIncluded).toBe(true);
  });

  test("renders nothing and leaves the trace flag false when there's no summary", () => {
    const none = assemblePrompt(config, ctx(null));
    expect(none.static).toBe("");
    expect(none.trace.compactSummaryIncluded).toBe(false);

    const empty = assemblePrompt(config, ctx("   "));
    expect(empty.trace.compactSummaryIncluded).toBe(false);
  });
});
