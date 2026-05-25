import process from "node:process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildClaudeSdkEnv } from "./env";

// Keys read via const identifiers (not string literals in brackets) so both
// tsc's noPropertyAccessFromIndexSignature and Biome's useLiteralKeys stay happy.
const KEY_API = "ANTHROPIC_API_KEY";
const KEY_MDS = "CLAUDE_CODE_DISABLE_CLAUDE_MDS";
const KEY_SENTINEL = "NEO_TAVERN_SENTINEL";

// Variable-key writes for the same reason.
const setEnvVar = (key: string, value: string): void => {
  process.env[key] = value;
};

describe("buildClaudeSdkEnv — locks the st-claude-proxy painpoints", () => {
  let snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot = { ...process.env };
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  });

  test("never passes an API key through — sdk-mode bills the Max sub (token extraction got the proxy banned)", () => {
    setEnvVar(KEY_API, "sk-ant-must-not-reach-the-subprocess");

    // Present-as-undefined so the spawned subprocess never receives it.
    expect(buildClaudeSdkEnv()[KEY_API]).toBeUndefined();
  });

  test("disables CLAUDE.md with the string 'true', NOT '1' (the isEnvTruthy gotcha that bit the proxy)", () => {
    const env = buildClaudeSdkEnv();

    expect(env[KEY_MDS]).toBe("true");
    expect(env[KEY_MDS]).not.toBe("1");
  });

  test("passes the host environment through so `claude login` (PATH/HOME) still resolves", () => {
    setEnvVar(KEY_SENTINEL, "kept");

    expect(buildClaudeSdkEnv()[KEY_SENTINEL]).toBe("kept");
  });
});
