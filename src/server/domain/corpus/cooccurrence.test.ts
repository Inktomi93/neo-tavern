import { describe, expect, it } from "vitest";
import { type DigestKeywords, normalizeKeyword, tallyCooccurrence } from "./cooccurrence";

describe("normalizeKeyword", () => {
  it("lowercases, folds a leading article, trims trailing punctuation", () => {
    expect(normalizeKeyword("The Moonlit Orchard")).toBe("moonlit orchard");
    expect(normalizeKeyword("body transformation!")).toBe("body transformation");
    expect(normalizeKeyword("  Glitter-chan  ")).toBe("glitter-chan");
  });
  it("drops tokens under 4 chars", () => {
    expect(normalizeKeyword("cat")).toBeNull();
    expect(normalizeKeyword("a")).toBeNull();
    expect(normalizeKeyword("vow")).toBeNull();
  });
});

describe("tallyCooccurrence", () => {
  const d = (characterId: string, kws: string[]): DigestKeywords => ({
    characterId,
    keywords: new Set(kws),
  });

  it("counts every unordered keyword pair once per digest, canonical order", () => {
    const { pairs } = tallyCooccurrence([d("c1", ["b", "a", "c"])]);
    const byKey = new Map(pairs.map((p) => [`${p.keywordA}/${p.keywordB}`, p.count]));
    expect(byKey.get("a/b")).toBe(1);
    expect(byKey.get("a/c")).toBe(1);
    expect(byKey.get("b/c")).toBe(1);
    expect(pairs).toHaveLength(3); // C(3,2)
  });

  it("accumulates a pair's count across digests and dedupes its character sample", () => {
    const { pairs } = tallyCooccurrence([
      d("c1", ["orchard", "moonlight"]),
      d("c1", ["orchard", "moonlight"]), // same character → still one in the sample
      d("c2", ["orchard", "moonlight"]),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.count).toBe(3);
    expect([...(pairs[0]?.characterIds ?? [])].sort()).toEqual(["c1", "c2"]);
  });

  it("credits each keyword to its character", () => {
    const { charKeywords } = tallyCooccurrence([d("c1", ["a", "b"]), d("c1", ["a"])]);
    const a = charKeywords.find((x) => x.keyword === "a" && x.characterId === "c1");
    const b = charKeywords.find((x) => x.keyword === "b" && x.characterId === "c1");
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
  });

  it("caps the per-pair character sample", () => {
    const digests = Array.from({ length: 30 }, (_, i) => d(`c${i}`, ["x", "y"]));
    const { pairs } = tallyCooccurrence(digests, { maxCharSample: 5 });
    expect(pairs[0]?.count).toBe(30);
    expect(pairs[0]?.characterIds).toHaveLength(5);
  });
});
