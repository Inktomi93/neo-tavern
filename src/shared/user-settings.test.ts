import { describe, expect, test } from "vitest";
import { DEFAULT_USER_SETTINGS, parseUserSettings, userSettingsSchema } from "./user-settings";

describe("parseUserSettings", () => {
  test("an empty blob resolves to defaults (regexScripts: [], everything else unset)", () => {
    expect(parseUserSettings({})).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings({}).regexScripts).toEqual([]);
  });

  test("non-object / null / legacy garbage never throws — falls back to defaults", () => {
    expect(parseUserSettings(null)).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings(undefined)).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings("nope")).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings(42)).toEqual(DEFAULT_USER_SETTINGS);
  });

  test("a valid full blob round-trips", () => {
    const full = {
      defaultPresetId: "preset-1",
      defaultPersonaId: "persona-1",
      defaultApi: "chat-completions" as const,
      defaultSource: "openrouter" as const,
      defaultModel: "anthropic/claude-opus-4.7",
      defaultGeneration: { temperature: 0.8, maxOutputTokens: 1024 },
      profile: { avatarAssetId: "a".repeat(64) },
      regexScripts: [],
    };
    const parsed = parseUserSettings(full);
    expect(parsed.defaultPresetId).toBe("preset-1");
    expect(parsed.defaultApi).toBe("chat-completions");
    expect(parsed.defaultGeneration?.temperature).toBe(0.8);
    expect(parsed.profile?.avatarAssetId).toBe("a".repeat(64));
  });

  test("one corrupt field self-heals (.catch) without nuking the rest of the blob", () => {
    const parsed = parseUserSettings({
      defaultPresetId: "keep-me",
      defaultApi: "not-a-real-api", // invalid enum → resets to undefined, doesn't fail the parse
      defaultGeneration: { temperature: "hot" }, // invalid → resets to undefined
    });
    expect(parsed.defaultPresetId).toBe("keep-me"); // survived
    expect(parsed.defaultApi).toBeUndefined(); // healed
    expect(parsed.defaultGeneration).toBeUndefined(); // healed
  });

  test("an unknown top-level key is dropped, not preserved", () => {
    const parsed = parseUserSettings({ defaultPresetId: "p", legacyJunk: { a: 1 } });
    expect(Object.keys(parsed)).not.toContain("legacyJunk");
    expect(parsed.defaultPresetId).toBe("p");
  });

  test("a legacy blob carrying regexScripts is subsumed (the field's only home now)", () => {
    const script = {
      id: "r1",
      name: "trim",
      findRegex: "foo",
      replaceString: "bar",
      placement: ["AI_OUTPUT" as const],
    };
    const parsed = parseUserSettings({ regexScripts: [script] });
    expect(parsed.regexScripts).toHaveLength(1);
    expect(parsed.regexScripts[0]?.id).toBe("r1");
    expect(parsed.regexScripts[0]?.enabled).toBe(true); // schema default filled
  });

  test("the write schema is lenient too: a malformed regex element coerces away (.catch), no throw", () => {
    // userSettingsSchema is the tRPC write input. Per-field .catch means writes self-heal rather than
    // 400 — acceptable for single-user (the typed frontend sends valid data); the parser is the contract.
    const result = userSettingsSchema.safeParse({ regexScripts: [{ id: "" }] });
    expect(result.success).toBe(true);
    expect(result.success && result.data.regexScripts).toEqual([]);
  });
});
