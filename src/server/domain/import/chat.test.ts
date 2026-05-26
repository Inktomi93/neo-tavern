import { describe, expect, test } from "vitest";
import { parseStDate } from "./chat";

// parseStDate must yield ONE canonical UTC instant for every ST encoding — independent of the host
// timezone (the bug this locks: the old local-tz Date(...) constructor drifted by server tz).
describe("parseStDate — every format resolves to the same UTC epoch-ms", () => {
  test("epoch number: seconds promote, ms pass through", () => {
    expect(parseStDate(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseStDate(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  test("numeric-string epoch (≥10 digits)", () => {
    expect(parseStDate("1700000000")).toBe(1_700_000_000_000);
    expect(parseStDate("2025")).toBeNull(); // too short — not misread as epoch seconds
  });

  test("ISO 8601 (naive read as UTC)", () => {
    expect(parseStDate("2025-07-03T14:56:48Z")).toBe(Date.UTC(2025, 6, 3, 14, 56, 48));
    expect(parseStDate("2025-07-03T14:56:48")).toBe(Date.UTC(2025, 6, 3, 14, 56, 48));
  });

  test("ST '@14h56m48s' format → UTC", () => {
    expect(parseStDate("2025-07-03@14h56m48s")).toBe(Date.UTC(2025, 6, 3, 14, 56, 48));
    expect(parseStDate("2025-07-03 @ 14h56m48s 989ms")).toBe(Date.UTC(2025, 6, 3, 14, 56, 48));
  });

  test("human readable, with and without time → UTC", () => {
    expect(parseStDate("August 27, 2025 6:36pm")).toBe(Date.UTC(2025, 7, 27, 18, 36));
    expect(parseStDate("August 27, 2025 12:00am")).toBe(Date.UTC(2025, 7, 27, 0, 0));
    expect(parseStDate("August 27, 2025")).toBe(Date.UTC(2025, 7, 27));
  });

  test("empty / null → null", () => {
    expect(parseStDate(null)).toBeNull();
    expect(parseStDate("")).toBeNull();
    expect(parseStDate("garbage")).toBeNull();
  });
});
