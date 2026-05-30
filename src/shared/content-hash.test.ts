import { describe, expect, it } from "vitest";
import { collapseByContentHash, contentHash } from "./content-hash";

describe("contentHash", () => {
  it("is deterministic and stable for identical source text", () => {
    expect(contentHash("User: hi\nAda: hello")).toBe(contentHash("User: hi\nAda: hello"));
  });
  it("differs for different text", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});

describe("collapseByContentHash", () => {
  it("keeps one representative per distinct hash, preserving first-occurrence order", () => {
    const rows = [
      { id: 1, contentHash: "a" },
      { id: 2, contentHash: "b" },
      { id: 3, contentHash: "a" }, // dup of #1
      { id: 4, contentHash: "b" }, // dup of #2
      { id: 5, contentHash: "c" },
    ];
    const { representatives, duplicateCount, membersByHash } = collapseByContentHash(rows);
    expect(representatives.map((r) => r.id)).toEqual([1, 2, 5]);
    expect(duplicateCount).toBe(2);
    expect(membersByHash.get("a")?.map((r) => r.id)).toEqual([1, 3]);
    expect(membersByHash.get("b")?.map((r) => r.id)).toEqual([2, 4]);
    expect(membersByHash.get("c")?.map((r) => r.id)).toEqual([5]);
  });

  it("always keeps null-hash rows (no identity to collapse on)", () => {
    const rows = [
      { id: 1, contentHash: null },
      { id: 2, contentHash: null },
      { id: 3, contentHash: "x" },
      { id: 4, contentHash: "x" },
    ];
    const { representatives, duplicateCount } = collapseByContentHash(rows);
    expect(representatives.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(duplicateCount).toBe(1);
  });

  it("is a no-op on already-unique input", () => {
    const rows = [
      { id: 1, contentHash: "a" },
      { id: 2, contentHash: "b" },
    ];
    const { representatives, duplicateCount } = collapseByContentHash(rows);
    expect(representatives).toHaveLength(2);
    expect(duplicateCount).toBe(0);
  });
});
