import { describe, expect, test } from "vitest";
import { BLOB_ROUTE, blobUrl, isAssetHash } from "./assets";

const HASH = "a".repeat(64);

describe("asset addressing", () => {
  test("blobUrl maps a hash onto its /blob route", () => {
    expect(blobUrl(HASH)).toBe(`/blob/${HASH}`);
    expect(blobUrl(HASH).startsWith(BLOB_ROUTE)).toBe(true);
  });

  test("isAssetHash accepts a 64-char lowercase hex digest, rejects everything else", () => {
    expect(isAssetHash(HASH)).toBe(true);
    expect(isAssetHash(`${"f".repeat(63)}`)).toBe(false); // too short
    expect(isAssetHash("g".repeat(64))).toBe(false); // non-hex
    expect(isAssetHash(HASH.toUpperCase())).toBe(false); // lowercase only
    expect(isAssetHash("../../etc/passwd")).toBe(false); // traversal guard
  });
});
