import { describe, expect, test } from "vitest";
import { appSettingsSchema, parseAppSettings } from "./app-settings";

describe("parseAppSettings", () => {
  test("empty / non-object → no overrides ({})", () => {
    expect(parseAppSettings({})).toEqual({});
    expect(parseAppSettings(null)).toEqual({});
    expect(parseAppSettings("nope")).toEqual({});
    expect(parseAppSettings(undefined)).toEqual({});
  });

  test("valid overrides round-trip", () => {
    const parsed = parseAppSettings({
      corpusAutoindex: false,
      importSkipCharacters: ["Ruby"],
      logLevel: "debug",
      idleUnloadMin: 0,
    });
    expect(parsed.corpusAutoindex).toBe(false);
    expect(parsed.importSkipCharacters).toEqual(["Ruby"]);
    expect(parsed.logLevel).toBe("debug");
    expect(parsed.idleUnloadMin).toBe(0);
  });

  test("one corrupt field self-heals (.catch) without dropping the valid ones", () => {
    const parsed = parseAppSettings({
      corpusAutoindex: false, // valid → kept
      logLevel: "screaming", // invalid enum → reset to undefined (falls through to env later)
      idleUnloadMin: -5, // below min → reset to undefined
    });
    expect(parsed.corpusAutoindex).toBe(false);
    expect(parsed.logLevel).toBeUndefined();
    expect(parsed.idleUnloadMin).toBeUndefined();
  });

  test("the write schema accepts a partial (admin flips one toggle)", () => {
    const result = appSettingsSchema.safeParse({ corpusAutoindex: false });
    expect(result.success).toBe(true);
    expect(result.success && result.data.logLevel).toBeUndefined();
  });
});
