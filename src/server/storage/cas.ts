// Content-addressed blob store (infrastructure — a filesystem adapter, like providers/embeddings).
// Pure blob I/O keyed by the sha-256 of the content; imports only `shared` + node + atomically,
// NEVER db. The domain/assets feature orchestrates this with the `assets` index rows. Scale here
// is ~320 small PNGs for one user, so a sharded directory IS the right tier (no object store); the
// hash key ports to S3 unchanged if that ever changes. See docs/assets.md + docs/data-model.md.
//
// Footguns handled (the reason CAS libraries exist):
//   • sha-256, so a card blob's hash == characters.importHash (the whole-file hash already stored).
//   • sharded `ab/cd/<hash>` (never one flat dir of thousands).
//   • durable atomic write via `atomically`: a temp file UNDER rootDir (`.tmp/`, same filesystem —
//     a cross-device rename silently degrades to a non-atomic copy) → fsync → rename into place.
//     Never the final path directly, so a crashed write can't leave a corrupt blob at its hash.
//   • write-once dedup: identical bytes hash identically → the second put is a no-op.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFile } from "atomically";
import { isAssetHash } from "../../shared/assets";

export interface PutResult {
  hash: string;
  size: number;
  /** false if the blob already existed (dedup) — the write was skipped. */
  created: boolean;
}

export interface Cas {
  /** Store bytes under their sha-256. Idempotent: identical bytes dedup to one blob. */
  putBytes(bytes: Uint8Array): Promise<PutResult>;
  /** The sharded on-disk path for a hash. Throws on a non-hash (path-traversal guard). */
  blobPath(hash: string): string;
  exists(hash: string): Promise<boolean>;
  read(hash: string): Promise<Uint8Array>;
  /** Re-hash the bytes on disk and compare to the name — catches silent corruption. */
  verify(hash: string): Promise<boolean>;
  /** Delete a blob. Idempotent (a missing blob is not an error). */
  remove(hash: string): Promise<void>;
  /** Walk the sharded tree, yielding every stored hash (GC / fsck / rebuild). */
  listHashes(): AsyncIterable<string>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const SHARD = /^[0-9a-f]{2}$/;

// readdir(withFileTypes) with a tolerant catch (a not-yet-created tree is empty, not an error).
// Typed Dirent[] like domain/import/loader.ts — `ReturnType<typeof readdir>` picks the wrong overload.
async function safeReaddir(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function createCas(rootDir: string): Cas {
  const tmpDir = join(rootDir, ".tmp");

  function blobPath(hash: string): string {
    if (!isAssetHash(hash)) {
      throw new Error(`cas: not a valid content hash: ${JSON.stringify(hash)}`);
    }
    return join(rootDir, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async function exists(hash: string): Promise<boolean> {
    try {
      await stat(blobPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async function read(hash: string): Promise<Uint8Array> {
    return readFile(blobPath(hash));
  }

  return {
    blobPath,
    exists,
    read,

    async putBytes(bytes) {
      const hash = sha256(bytes);
      const size = bytes.byteLength;
      const dest = blobPath(hash);
      if (await exists(hash)) return { hash, size, created: false };

      // Both the shard dir and the temp dir must exist before the atomic write; both live under
      // rootDir, so the temp→dest rename stays on one filesystem (atomic).
      await mkdir(join(rootDir, hash.slice(0, 2), hash.slice(2, 4)), { recursive: true });
      await mkdir(tmpDir, { recursive: true });
      await writeFile(dest, bytes, {
        fsync: true,
        tmpCreate: () => join(tmpDir, `${hash}.${randomUUID()}.tmp`),
      });
      return { hash, size, created: true };
    },

    async verify(hash) {
      try {
        return sha256(await read(hash)) === hash;
      } catch {
        return false; // missing or unreadable ⇒ not verifiable
      }
    },

    async remove(hash) {
      await rm(blobPath(hash), { force: true });
    },

    async *listHashes() {
      for (const s1 of await safeReaddir(rootDir)) {
        if (!s1.isDirectory() || !SHARD.test(s1.name)) continue; // skips .tmp + stray entries
        const d1 = join(rootDir, s1.name);
        for (const s2 of await safeReaddir(d1)) {
          if (!s2.isDirectory() || !SHARD.test(s2.name)) continue;
          const d2 = join(d1, s2.name);
          for (const f of await safeReaddir(d2)) {
            if (f.isFile() && isAssetHash(f.name)) yield f.name;
          }
        }
      }
    },
  };
}
