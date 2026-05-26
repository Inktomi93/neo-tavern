import process from "node:process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildClaudeOpenRouterEnv, buildClaudeSdkEnv } from "./env";

// Keys read via const identifiers (not string literals in brackets) so both
// tsc's noPropertyAccessFromIndexSignature and Biome's useLiteralKeys stay happy.
const KEY_API = "ANTHROPIC_API_KEY";
const KEY_MDS = "CLAUDE_CODE_DISABLE_CLAUDE_MDS";
const KEY_SENTINEL = "NEO_TAVERN_SENTINEL";
const KEY_BASE_URL = "ANTHROPIC_BASE_URL";
const KEY_AUTH_TOKEN = "ANTHROPIC_AUTH_TOKEN";
const KEY_CLAUDE_CONFIG_DIR = "CLAUDE_CONFIG_DIR";
const KEY_ANTHROPIC_CONFIG_DIR = "ANTHROPIC_CONFIG_DIR";
const KEY_OAUTH = "CLAUDE_CODE_OAUTH_TOKEN";
const KEY_OPUS = "ANTHROPIC_DEFAULT_OPUS_MODEL";

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

  test("nulls the OpenRouter-skin vars so a stale ambient export can't repoint the FREE sub at a paid base URL", () => {
    // Simulate a stale shell export (or a leaked mode-2 var) in the host env.
    setEnvVar(KEY_BASE_URL, "https://openrouter.ai/api");
    setEnvVar(KEY_AUTH_TOKEN, "sk-or-leaked-into-the-shell");

    const env = buildClaudeSdkEnv();
    // Sub mode must NOT inherit them — else it'd send the sub OAuth token to a third party.
    expect(env[KEY_BASE_URL]).toBeUndefined();
    expect(env[KEY_AUTH_TOKEN]).toBeUndefined();
  });
});

describe("buildClaudeOpenRouterEnv — Claude-API mode (the Anthropic skin + credential firewall)", () => {
  test("requires a non-empty OpenRouter key (the 'key required' invariant is explicit)", () => {
    expect(() => buildClaudeOpenRouterEnv("")).toThrow(/OpenRouter API key is required/);
  });

  test("sets the Anthropic-skin trio: empty API key (NOT unset), OpenRouter base URL, the OR auth token", () => {
    const env = buildClaudeOpenRouterEnv("sk-or-test-key");

    // ANTHROPIC_API_KEY MUST be the empty string, not undefined — an unset key lets the
    // runtime fall through to other credential sources (the skin recipe is explicit on this).
    expect(env[KEY_API]).toBe("");
    expect(env[KEY_BASE_URL]).toBe("https://openrouter.ai/api");
    expect(env[KEY_AUTH_TOKEN]).toBe("sk-or-test-key");
    expect(env[KEY_OPUS]).toBe("anthropic/claude-opus-4.7");
  });

  test("FIREWALL: isolates both config dirs to an empty ephemeral dir (sub token unreachable) + nulls other credential sources", () => {
    const env = buildClaudeOpenRouterEnv("sk-or-test-key");

    const claudeDir = env[KEY_CLAUDE_CONFIG_DIR];
    const anthropicDir = env[KEY_ANTHROPIC_CONFIG_DIR];
    // Both credential-dir knobs point at the SAME isolated temp dir — never the host ~/.claude
    // (where the `claude login` token lives), so this spawn physically can't read the sub token.
    expect(claudeDir).toBeDefined();
    expect(claudeDir).toContain("neo-tavern-claude-or-");
    expect(anthropicDir).toBe(claudeDir);
    // Every OTHER credential source the runtime reads is nulled — only the OR auth token is in scope.
    expect(env[KEY_OAUTH]).toBeUndefined();
  });
});
