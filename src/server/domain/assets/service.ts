// Asset domain — orchestrates the CAS blob store (infra) with the `assets` index rows (db) and the
// avatar references on character_versions / personas. The blob is content (storage/cas.ts); the row
// is metadata; this is where they're kept coherent. No ownerId — assets are global + deduped by hash
// (identical art across users is one blob). GC is mark-sweep over the avatar refs (no refcount
// column to drift). See docs/data-model.md + docs/assets.md.

import { stat } from "node:fs/promises";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { assets, auditLogs, characters, characterVersions, personas } from "../../../db/schema";
import type { AssetKind } from "../../../shared/assets";
import { getLog } from "../../observability/logger";
import type { Cas } from "../../storage/cas";
import { newId } from "../_shared/ids";

export interface StoredAsset {
  assetId: string;
  hash: string;
  size: number;
  /** false if the blob already existed (dedup). */
  created: boolean;
}

/** One card to (re)link to its character's current version (the backfill input). */
export interface BackfillCard {
  handle: string; // slugifyHandle(pngStem) — the character identity key
  bytes: Uint8Array; // the raw PNG bytes
}
export interface BackfillResult {
  linked: number; // versions that got an avatarAssetId set
  skipped: number; // already linked, or no matching character/version
  mismatches: string[]; // handles whose stored hash ≠ characters.importHash (NOT linked — integrity guard)
}

export interface GcOptions {
  /** Don't sweep a blob younger than this (ms) — guards against racing an in-flight import that
   *  stored the blob but hasn't linked it yet. */
  graceMs: number;
  now?: number; // injectable clock for tests; defaults to Date.now()
}
export interface GcResult {
  scanned: number;
  removed: number;
  keptReferenced: number;
  keptWithinGrace: number;
}

export interface FsckResult {
  rows: number;
  ok: number;
  dangling: string[]; // assets rows whose blob is missing
  corrupt: string[]; // assets rows whose blob fails re-hash verification
  orphans: string[]; // blobs on disk with no assets row
}

export interface AssetsService {
  store(bytes: Uint8Array, kind: AssetKind, mime: string): Promise<StoredAsset>;
  getMetadata(hash: string): Promise<{ mime: string; size: number } | undefined>;
  backfillAvatars(ownerId: string, cards: BackfillCard[]): Promise<BackfillResult>;
  collectGarbage(options: GcOptions): Promise<GcResult>;
  fsck(): Promise<FsckResult>;
  /** DR: re-derive `assets` rows for orphan blobs (walk + hash the tree). Returns counts. */
  rebuildFromTree(kind: AssetKind): Promise<{ created: number; existing: number }>;
}

// Minimal magic-byte sniff for rebuild (cards are PNG; avatars may be jpg/webp). Falls back to a
// generic type — rebuild is a DR path, the row's mime is a best effort, not authoritative.
function sniffMime(bytes: Uint8Array): string {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

export function createAssetsService(db: Db, cas: Cas): AssetsService {
  const log = getLog();

  async function assetIdForHash(hash: string): Promise<string | undefined> {
    return (
      await db.select({ id: assets.id }).from(assets).where(eq(assets.hash, hash)).limit(1)
    )[0]?.id;
  }

  const store: AssetsService["store"] = async (bytes, kind, mime) => {
    const put = await cas.putBytes(bytes);
    // Upsert the index row by hash (the blob may already exist from a prior put, or be brand new).
    await db
      .insert(assets)
      .values({ id: newId(), kind, mime, size: put.size, hash: put.hash, uploadedAt: Date.now() })
      .onConflictDoNothing({ target: assets.hash });
    const assetId = await assetIdForHash(put.hash);
    if (assetId === undefined)
      throw new Error(`assets.store: row missing after upsert (${put.hash})`);
    // debug, not info: store is per-op (called once per card during a 310-card import) — the batch
    // jobs below log their info-level summary. Metadata only (hash/kind/size — never the bytes).
    log.debug(
      { hash: put.hash, kind, size: put.size, created: put.created },
      "assets: stored blob",
    );
    return { assetId, hash: put.hash, size: put.size, created: put.created };
  };

  return {
    store,

    async getMetadata(hash) {
      const row = (
        await db
          .select({ mime: assets.mime, size: assets.size })
          .from(assets)
          .where(eq(assets.hash, hash))
          .limit(1)
      )[0];
      return row;
    },

    async backfillAvatars(ownerId, cards) {
      let linked = 0;
      let skipped = 0;
      const mismatches: string[] = [];

      for (const card of cards) {
        const char = (
          await db
            .select({
              importHash: characters.importHash,
              currentVersionId: characters.currentVersionId,
            })
            .from(characters)
            .where(and(eq(characters.ownerId, ownerId), eq(characters.handle, card.handle)))
            .limit(1)
        )[0];
        if (!char?.currentVersionId) {
          skipped++;
          continue;
        }
        const ver = (
          await db
            .select({ id: characterVersions.id, avatarAssetId: characterVersions.avatarAssetId })
            .from(characterVersions)
            .where(eq(characterVersions.id, char.currentVersionId))
            .limit(1)
        )[0];
        if (!ver || ver.avatarAssetId !== null) {
          skipped++; // no version, or already linked (idempotent re-run)
          continue;
        }
        const stored = await store(card.bytes, "card", "image/png");
        // Integrity check: the card blob's hash IS the whole-file sha256 the importer recorded.
        if (char.importHash !== null && char.importHash !== stored.hash) {
          mismatches.push(card.handle);
          continue; // the on-disk PNG doesn't match what was imported — don't link a wrong avatar
        }
        await db
          .update(characterVersions)
          .set({ avatarAssetId: stored.assetId })
          .where(eq(characterVersions.id, ver.id));
        linked++;
      }

      log.info({ linked, skipped, mismatches: mismatches.length }, "assets: backfilled avatars");
      return { linked, skipped, mismatches };
    },

    async collectGarbage({ graceMs, now = Date.now() }) {
      const referencedHashesRows = await db
        .selectDistinct({ hash: assets.hash })
        .from(assets)
        .where(
          or(
            inArray(
              assets.id,
              db
                .select({ id: characterVersions.avatarAssetId })
                .from(characterVersions)
                .where(isNotNull(characterVersions.avatarAssetId)),
            ),
            inArray(
              assets.id,
              db
                .select({ id: personas.avatarAssetId })
                .from(personas)
                .where(isNotNull(personas.avatarAssetId)),
            ),
          ),
        );

      const referencedHashes = new Set(referencedHashesRows.map((r) => r.hash));

      let scanned = 0;
      let removed = 0;
      let keptReferenced = 0;
      let keptWithinGrace = 0;
      for await (const hash of cas.listHashes()) {
        scanned++;
        if (referencedHashes.has(hash)) {
          keptReferenced++;
          continue;
        }
        // Orphan blob — but honor the grace window (an import may have just written it).
        const ageMs = now - (await stat(cas.blobPath(hash))).mtimeMs;
        if (ageMs < graceMs) {
          keptWithinGrace++;
          continue;
        }
        await cas.remove(hash);
        await db.delete(assets).where(eq(assets.hash, hash)); // drop the now-blobless row too

        await db.insert(auditLogs).values({
          id: newId(),
          timestamp: Date.now(),
          action: "DELETE_ASSET",
          domain: "assets",
          entityId: hash,
          details: { reason: "garbage_collection" },
        });

        removed++;
      }

      log.info({ scanned, removed, keptReferenced, keptWithinGrace }, "assets: gc swept");
      return { scanned, removed, keptReferenced, keptWithinGrace };
    },

    async fsck() {
      const rows = await db.select({ hash: assets.hash }).from(assets);
      const known = new Set<string>();
      const dangling: string[] = [];
      const corrupt: string[] = [];
      let ok = 0;
      for (const row of rows) {
        known.add(row.hash);
        if (!(await cas.exists(row.hash))) {
          dangling.push(row.hash);
        } else if (!(await cas.verify(row.hash))) {
          corrupt.push(row.hash);
        } else {
          ok++;
        }
      }
      const orphans: string[] = [];
      for await (const hash of cas.listHashes()) {
        if (!known.has(hash)) orphans.push(hash);
      }
      const counts = {
        rows: rows.length,
        ok,
        dangling: dangling.length,
        corrupt: corrupt.length,
        orphans: orphans.length,
      };
      if (dangling.length + corrupt.length + orphans.length > 0) {
        log.warn(counts, "assets: fsck found issues");
      } else {
        log.info(counts, "assets: fsck clean");
      }
      return { rows: rows.length, ok, dangling, corrupt, orphans };
    },

    async rebuildFromTree(kind) {
      let created = 0;
      let existing = 0;
      for await (const hash of cas.listHashes()) {
        if ((await assetIdForHash(hash)) !== undefined) {
          existing++;
          continue;
        }
        const bytes = await cas.read(hash);
        await db
          .insert(assets)
          .values({
            id: newId(),
            kind,
            mime: sniffMime(bytes),
            size: bytes.byteLength,
            hash,
            uploadedAt: Date.now(),
          })
          .onConflictDoNothing({ target: assets.hash });
        created++;
      }
      log.info({ created, existing, kind }, "assets: rebuilt rows from tree");
      return { created, existing };
    },
  };
}
