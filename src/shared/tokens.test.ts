import { describe, expect, test } from "vitest";
import { estimateTokens, estimateTokensBatch } from "./tokens";

describe("estimateTokens (QuadChars)", () => {
  test("empty string is zero", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("printable ASCII groups 4 chars per token (ceil)", () => {
    expect(estimateTokens("a")).toBe(1); // ceil(1/4)
    expect(estimateTokens("test")).toBe(1); // 4 → 1
    expect(estimateTokens("abcdefgh")).toBe(2); // 8 → 2
    expect(estimateTokens("hello world")).toBe(3); // 11 incl. space → ceil(11/4)=3
  });

  test("each non-ASCII codepoint counts as its own token", () => {
    expect(estimateTokens("café")).toBe(2); // "caf" → ceil(3/4)=1, "é" → 1
    expect(estimateTokens("日本語")).toBe(3); // 3 CJK codepoints
    expect(estimateTokens("👍")).toBe(1); // single emoji codepoint
  });

  test("control characters (newline, tab) count separately, not grouped", () => {
    expect(estimateTokens("\n")).toBe(1);
    expect(estimateTokens("\t")).toBe(1);
  });

  test("batch preserves input order", () => {
    expect(estimateTokensBatch(["", "test", "café"])).toEqual([0, 1, 2]);
  });
});
