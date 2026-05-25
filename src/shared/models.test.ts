import { describe, expect, test } from "vitest";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL_ID } from "./models";

describe("chat model catalog", () => {
  test("the default model id actually exists in the catalog", () => {
    expect(CHAT_MODELS.map((model) => model.id)).toContain(DEFAULT_CHAT_MODEL_ID);
  });

  test("every model id is unique", () => {
    const ids = CHAT_MODELS.map((model) => model.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
