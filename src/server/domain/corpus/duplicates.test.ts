import { describe, expect, it } from "vitest";
import { chatRelation, forkRoots, jaccardChatPairs, pairsAboveThreshold } from "./duplicates";

// Build a 1024-dim vector from sparse {index: value} entries (the rest zero).
function vec(entries: Record<number, number>): Float32Array {
  const v = new Float32Array(1024);
  for (const [i, x] of Object.entries(entries)) v[Number(i)] = x;
  return v;
}

describe("pairsAboveThreshold", () => {
  it("emits near-identical pairs, excludes dissimilar ones, canonical id order", () => {
    const ids = ["b", "a", "c"]; // deliberately unsorted to prove canonical (a<b) output
    const vecs = [
      vec({ 0: 1, 1: 0.02 }), // b ≈ a
      vec({ 0: 1 }), //          a
      vec({ 5: 1 }), //          c — orthogonal to a/b
    ];
    const pairs = pairsAboveThreshold(ids, vecs, new Map(), 0.92);
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect([p?.idA, p?.idB]).toEqual(["a", "b"]); // canonical (sorted) regardless of input order
    expect(p?.cosine).toBeGreaterThan(0.999);
  });

  it("CSLS subtracts both endpoints' hub scores", () => {
    const ids = ["x", "y"];
    const vecs = [vec({ 0: 1 }), vec({ 0: 1 })]; // identical → cos = 1
    const hubs = new Map([
      ["x", 0.5],
      ["y", 0.3],
    ]);
    const [p] = pairsAboveThreshold(ids, vecs, hubs, 0.92);
    expect(p?.cosine).toBeCloseTo(1, 5);
    expect(p?.csls).toBeCloseTo(2 * 1 - 0.5 - 0.3, 5); // 2·cos − hubX − hubY
  });

  it("respects the threshold (a moderately-similar pair below it is dropped)", () => {
    const ids = ["a", "b"];
    // cosine ≈ 1/√2 ≈ 0.707 — above a loose threshold, below the default
    const vecs = [vec({ 0: 1 }), vec({ 0: 1, 1: 1 })];
    expect(pairsAboveThreshold(ids, vecs, new Map(), 0.92)).toHaveLength(0);
    expect(pairsAboveThreshold(ids, vecs, new Map(), 0.5)).toHaveLength(1);
  });
});

describe("jaccardChatPairs (content-overlap chat dedup, B.5.1)", () => {
  const eligible = new Set(["x", "y", "z", "w"]);
  const seg = (chatId: string, hashes: string[]) =>
    hashes.map((h) => ({ chatId, ownerId: "o", model: "m", contentHash: h }));

  it("flags chats that share most blocks, ignores chats sharing only a greeting", () => {
    const rows = [
      ...seg("x", ["h1", "h2", "h3", "h4"]), // x and y share h1..h3 (3/4)
      ...seg("y", ["h1", "h2", "h3", "h9"]),
      ...seg("z", ["h1", "z1", "z2", "z3", "z4"]), // z shares only h1 (the greeting) with x/y
    ];
    const pairs = jaccardChatPairs(rows, eligible, 0.3);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]?.idA, pairs[0]?.idB]).toEqual(["x", "y"]);
    // |∩|=3 (h1,h2,h3), |∪|=5 (h1,h2,h3,h4,h9) → 0.6
    expect(pairs[0]?.jaccard).toBeCloseTo(0.6, 5);
  });

  it("never pairs across owners even with identical content", () => {
    const rows = [
      { chatId: "x", ownerId: "o1", model: "m", contentHash: "h1" },
      { chatId: "x", ownerId: "o1", model: "m", contentHash: "h2" },
      { chatId: "y", ownerId: "o2", model: "m", contentHash: "h1" },
      { chatId: "y", ownerId: "o2", model: "m", contentHash: "h2" },
    ];
    expect(jaccardChatPairs(rows, new Set(["x", "y"]), 0.3)).toHaveLength(0);
  });

  it("excludes ineligible chats and null-hash rows", () => {
    const rows = [
      ...seg("x", ["h1", "h2"]),
      ...seg("w", ["h1", "h2"]), // w not in eligible
      { chatId: "x", ownerId: "o", model: "m", contentHash: null },
    ];
    expect(jaccardChatPairs(rows, new Set(["x"]), 0.1)).toHaveLength(0);
  });
});

describe("forkRoots / chatRelation (B.5.1 lineage)", () => {
  const rows = [
    { id: "c", parentChatId: null }, // root
    { id: "b", parentChatId: "c" }, // fork of c
    { id: "a", parentChatId: "b" }, // fork of b (grandchild)
    { id: "d", parentChatId: null }, // independent
  ];

  it("resolves every chat to its topmost fork ancestor", () => {
    const roots = forkRoots(rows);
    expect(roots.get("a")).toBe("c");
    expect(roots.get("b")).toBe("c");
    expect(roots.get("c")).toBe("c");
    expect(roots.get("d")).toBe("d");
  });

  it("labels same-family pairs `forked`, independent pairs `duplicate`", () => {
    const roots = forkRoots(rows);
    expect(chatRelation("a", "b", roots)).toBe("forked"); // both root c
    expect(chatRelation("a", "c", roots)).toBe("forked"); // grandchild + root
    expect(chatRelation("a", "d", roots)).toBe("duplicate"); // different families
  });

  it("is cycle-safe (a malformed parent chain does not hang)", () => {
    const cyclic = [
      { id: "x", parentChatId: "y" },
      { id: "y", parentChatId: "x" },
    ];
    const roots = forkRoots(cyclic);
    expect(roots.has("x")).toBe(true);
    expect(roots.has("y")).toBe(true);
  });
});
