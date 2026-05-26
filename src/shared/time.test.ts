import { describe, expect, test } from "vitest";
import { epochToMs, isoToMs, secondsToMs, utcFormatToMs } from "./time";

describe("canonical time helpers", () => {
  test("epochToMs: seconds promote to ms; ms pass through; non-finite/≤0 → null", () => {
    expect(epochToMs(1_700_000_000)).toBe(1_700_000_000_000); // seconds (~2023)
    expect(epochToMs(1_700_000_000_000)).toBe(1_700_000_000_000); // already ms
    expect(epochToMs(0)).toBeNull();
    expect(epochToMs(-5)).toBeNull();
    expect(epochToMs(Number.NaN)).toBeNull();
  });

  test("secondsToMs: documented-seconds → ms; passes undefined through", () => {
    expect(secondsToMs(1_780_030_800)).toBe(1_780_030_800_000); // the SDK resetsAt case
    expect(secondsToMs(undefined)).toBeUndefined();
    expect(secondsToMs(null)).toBeUndefined();
  });

  test("isoToMs: offset and NAIVE iso both read as UTC (deterministic, not host-local)", () => {
    const utc = Date.UTC(2025, 6, 3, 14, 56, 48);
    expect(isoToMs("2025-07-03T14:56:48Z")).toBe(utc);
    expect(isoToMs("2025-07-03T14:56:48")).toBe(utc); // naive → UTC, NOT local tz
    expect(isoToMs("not a date")).toBeNull();
  });

  test("utcFormatToMs: explicit format parsed as UTC", () => {
    expect(utcFormatToMs("2025-07-03 14:56", "yyyy-MM-dd HH:mm")).toBe(
      Date.UTC(2025, 6, 3, 14, 56),
    );
    expect(utcFormatToMs("nope", "yyyy-MM-dd")).toBeNull();
  });
});
