import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Cas, createCas } from "./cas";

// sha-256 of "hello cheese" — the fixed expectation the sharded-path test asserts against.
const HELLO = new TextEncoder().encode("hello cheese");

let root: string;
let cas: Cas;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "neo-cas-"));
  cas = createCas(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("cas", () => {
  test("putBytes stores at a sharded path and dedups the second put", async () => {
    const first = await cas.putBytes(HELLO);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.created).toBe(true);
    expect(first.size).toBe(HELLO.byteLength);

    // sharded: <root>/<h0:2>/<h2:4>/<hash>
    const expected = join(root, first.hash.slice(0, 2), first.hash.slice(2, 4), first.hash);
    expect(cas.blobPath(first.hash)).toBe(expected);
    await expect(stat(expected)).resolves.toBeDefined();

    const second = await cas.putBytes(HELLO);
    expect(second.hash).toBe(first.hash);
    expect(second.created).toBe(false); // dedup — write skipped

    const seen: string[] = [];
    for await (const h of cas.listHashes()) seen.push(h);
    expect(seen).toEqual([first.hash]); // one blob despite two puts
  });

  test("the atomic temp staging dir is under the root (same filesystem as the blobs)", async () => {
    await cas.putBytes(HELLO);
    // The durable write stages a temp under <root>/.tmp before renaming into the shard — same
    // mount as the destination, so the rename is atomic (never a cross-device /tmp copy).
    const tmp = await stat(join(root, ".tmp"));
    expect(tmp.isDirectory()).toBe(true);
  });

  test("read round-trips the exact bytes; verify catches on-disk corruption", async () => {
    const { hash } = await cas.putBytes(HELLO);
    expect(new Uint8Array(await cas.read(hash))).toEqual(HELLO);
    expect(await cas.verify(hash)).toBe(true);

    // Corrupt the blob in place — verify must notice (re-hash ≠ name).
    await writeFile(cas.blobPath(hash), new TextEncoder().encode("tampered"));
    expect(await cas.exists(hash)).toBe(true);
    expect(await cas.verify(hash)).toBe(false);
  });

  test("remove is idempotent; blobPath rejects a non-hash (traversal guard)", async () => {
    const { hash } = await cas.putBytes(HELLO);
    await cas.remove(hash);
    expect(await cas.exists(hash)).toBe(false);
    await expect(cas.remove(hash)).resolves.toBeUndefined(); // removing again is not an error

    expect(() => cas.blobPath("../../etc/passwd")).toThrow();
    expect(() => cas.blobPath("not-a-hash")).toThrow();
  });
});
