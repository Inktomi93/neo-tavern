import { expect, test } from "vitest";
import { DEFAULT_CHAT_MODEL_ID, DEFAULT_RAW_MODEL_ID } from "../../../shared/models";
import { DEFAULT_PROMPT_CONFIG } from "../../../shared/prompt-config";
import { type RoutableChat, resolveTurnRouting } from "./routing";

function chat(over: Partial<RoutableChat>): RoutableChat {
  return { api: "agent-sdk", source: "max-pro-sub", model: null, metadata: null, ...over };
}

test("agent-sdk + no model → the agent-sdk runner + the default Claude model", () => {
  const r = resolveTurnRouting(chat({ api: "agent-sdk", model: null }), DEFAULT_PROMPT_CONFIG);

  expect(r).toEqual({
    runner: "agent-sdk",
    api: "agent-sdk",
    source: "max-pro-sub",
    model: DEFAULT_CHAT_MODEL_ID,
  });
});

test("agent-sdk + an unknown/stale model id falls back to the default (selection-time validity)", () => {
  const r = resolveTurnRouting(
    chat({ api: "agent-sdk", model: "claude-from-the-future-9" }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(r.model).toBe(DEFAULT_CHAT_MODEL_ID);
});

test("agent-sdk + a known Claude id is honored", () => {
  const r = resolveTurnRouting(
    chat({ api: "agent-sdk", model: "claude-sonnet-4-6" }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(r.model).toBe("claude-sonnet-4-6");
});

test("agent-sdk + source=openrouter routes the SAME runner (the paid Anthropic skin), source carried", () => {
  const r = resolveTurnRouting(
    chat({ api: "agent-sdk", source: "openrouter", model: "claude-opus-4-7" }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(r).toEqual({
    runner: "agent-sdk",
    api: "agent-sdk",
    source: "openrouter",
    model: "claude-opus-4-7",
  });
});

test("responses + no model → the openrouter runner + the default raw model", () => {
  const r = resolveTurnRouting(
    chat({ api: "responses", source: "openrouter", model: null }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(r).toMatchObject({ runner: "openrouter", api: "responses", model: DEFAULT_RAW_MODEL_ID });
});

test("responses + a model id is passed through verbatim (free OpenRouter id, not validated here)", () => {
  const r = resolveTurnRouting(
    chat({ api: "responses", source: "openrouter", model: "deepseek/deepseek-chat" }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(r.model).toBe("deepseek/deepseek-chat");
});

test("responses pulls providerRouting out of chat metadata; absent → undefined", () => {
  const withRouting = resolveTurnRouting(
    chat({
      api: "responses",
      source: "openrouter",
      metadata: { providerRouting: { order: ["anthropic"], allowFallbacks: false } },
    }),
    DEFAULT_PROMPT_CONFIG,
  );
  const without = resolveTurnRouting(
    chat({ api: "responses", source: "openrouter", metadata: null }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(withRouting).toMatchObject({
    runner: "openrouter",
    providerRouting: { order: ["anthropic"], allowFallbacks: false },
  });
  expect(without).toMatchObject({ runner: "openrouter", providerRouting: undefined });
});

test("incoherent / unimplemented api+source combos fail loud", () => {
  // responses requires source=openrouter.
  expect(() =>
    resolveTurnRouting(chat({ api: "responses", source: "max-pro-sub" }), DEFAULT_PROMPT_CONFIG),
  ).toThrow(/incoherent/);
  // chat-completions is designed but not yet built.
  expect(() =>
    resolveTurnRouting(
      chat({ api: "chat-completions", source: "openrouter" }),
      DEFAULT_PROMPT_CONFIG,
    ),
  ).toThrow(/not yet implemented/);
});
