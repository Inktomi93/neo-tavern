import { describe, expect, test } from "vitest";
import { disciplineOptions } from "./claude-sdk";

// The proxy's worst leak: a host plugin's SessionStart hook (superpowers) injected
// ~3.4k tokens into every request. These lock the config that prevents that class
// of bug — if someone "helpfully" loosens it, a test goes red.
const KEY_MDS = "CLAUDE_CODE_DISABLE_CLAUDE_MDS";

describe("Claude provider discipline — locks the proxy plugin/MCP/CLAUDE.md leak", () => {
  test("loads NO host settings/plugins/hooks (settingSources is empty)", () => {
    expect(disciplineOptions().settingSources).toEqual([]);
  });

  test("loads NO MCP servers and ignores host MCP config", () => {
    const options = disciplineOptions();

    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
  });

  test("enables NO built-in tools — this is RP, not coding", () => {
    expect(disciplineOptions().tools).toEqual([]);
  });

  test("its subprocess env kills CLAUDE.md injection", () => {
    expect(disciplineOptions().env[KEY_MDS]).toBe("true");
  });
});
