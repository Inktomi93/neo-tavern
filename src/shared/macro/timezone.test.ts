import { describe, expect, test, vi } from "vitest";
import { processMacros } from "./index";

// The {{time}}/{{date}} clock honors a per-request IANA timezone (the browser's zone, threaded from
// the chat-send path), falling back to server-local. These pin the GRACEFUL-DEGRADATION contract:
// an absent/invalid zone must never throw — it silently uses the server clock (and warns on invalid).
// (We can't assert an exact value: the macro reads the real wall clock; we assert shape + fallback.)

const base = { char: "C", user: "U", persona: "", scenario: "", env: {} } as const;
const HHMMSS = /^\d{2}:\d{2}:\d{2}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

describe("macro clock — timezone", () => {
  test("no timezone → well-formed server-local {{time}}/{{date}}", () => {
    expect(processMacros("{{time}}", base)).toMatch(HHMMSS);
    expect(processMacros("{{date}}", base)).toMatch(YMD);
  });

  test("valid IANA timezone → well-formed output, no throw", () => {
    expect(processMacros("{{time}}", { ...base, timezone: "Asia/Tokyo" })).toMatch(HHMMSS);
    expect(processMacros("{{date}}", { ...base, timezone: "America/New_York" })).toMatch(YMD);
  });

  test("invalid timezone → falls back to server-local and warns (never throws)", () => {
    const onWarn = vi.fn();
    const out = processMacros("{{time}}", { ...base, timezone: "Not/AZone", onWarn });
    expect(out).toMatch(HHMMSS); // produced a time rather than throwing
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("Not/AZone"));
  });
});
