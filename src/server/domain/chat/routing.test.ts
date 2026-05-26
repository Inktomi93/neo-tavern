import { expect, test } from "vitest";
import { DEFAULT_CHAT_MODEL_ID, DEFAULT_RAW_MODEL_ID } from "../../../shared/models";
import { DEFAULT_PROMPT_CONFIG } from "../../../shared/prompt-config";
import { type RoutableChat, resolveTurnRouting } from "./routing";

function chat(over: Partial<RoutableChat>): RoutableChat {
  return { mode: "sdk", provider: "anthropic-sdk", model: null, metadata: null, ...over };
}

test("sdk + no model → anthropic-sdk + the default Claude model", () => {
  const r = resolveTurnRouting(chat({ mode: "sdk", model: null }), DEFAULT_PROMPT_CONFIG);

  expect(r).toEqual({ mode: "sdk", provider: "anthropic-sdk", model: DEFAULT_CHAT_MODEL_ID });
});

test("sdk + an unknown/stale model id falls back to the default (selection-time validity)", () => {
  const r = resolveTurnRouting(
    chat({ mode: "sdk", model: "claude-from-the-future-9" }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(r.model).toBe(DEFAULT_CHAT_MODEL_ID);
});

test("sdk + a known Claude id is honored", () => {
  const r = resolveTurnRouting(
    chat({ mode: "sdk", model: "claude-sonnet-4-6" }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(r.model).toBe("claude-sonnet-4-6");
});

test("raw + no model → openrouter + the default raw model", () => {
  const r = resolveTurnRouting(
    chat({ mode: "raw", provider: "openrouter", model: null }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(r).toMatchObject({ mode: "raw", provider: "openrouter", model: DEFAULT_RAW_MODEL_ID });
});

test("raw + a model id is passed through verbatim (free OpenRouter id, not validated here)", () => {
  const r = resolveTurnRouting(
    chat({ mode: "raw", provider: "openrouter", model: "deepseek/deepseek-chat" }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(r.model).toBe("deepseek/deepseek-chat");
});

test("raw pulls providerRouting out of chat metadata; absent → undefined", () => {
  const withRouting = resolveTurnRouting(
    chat({
      mode: "raw",
      provider: "openrouter",
      metadata: { providerRouting: { order: ["anthropic"], allowFallbacks: false } },
    }),
    DEFAULT_PROMPT_CONFIG,
  );
  const without = resolveTurnRouting(
    chat({ mode: "raw", provider: "openrouter", metadata: null }),
    DEFAULT_PROMPT_CONFIG,
  );

  expect(withRouting).toMatchObject({
    mode: "raw",
    providerRouting: { order: ["anthropic"], allowFallbacks: false },
  });
  expect(without).toMatchObject({ mode: "raw", providerRouting: undefined });
});

test("incoherent / unimplemented mode+provider combos fail loud", () => {
  expect(() =>
    resolveTurnRouting(chat({ mode: "sdk", provider: "openrouter" }), DEFAULT_PROMPT_CONFIG),
  ).toThrow(/incoherent/);
  expect(() =>
    resolveTurnRouting(chat({ mode: "raw", provider: "anthropic-direct" }), DEFAULT_PROMPT_CONFIG),
  ).toThrow(/unsupported raw provider/);
});
