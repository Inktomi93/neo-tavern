// Public API (front door) for the assets domain feature: the content-addressed asset store.
// Orchestrates the CAS blob store (src/server/storage/cas.ts) with the `assets` index rows and the
// avatar references on character_versions / personas — store, avatar backfill, GC, fsck, rebuild.
// Composition roots (the server entry + the scripts/assets-*.ts CLIs) wire a Cas + Db into this.

export {
  type AssetsService,
  type BackfillCard,
  type BackfillResult,
  createAssetsService,
  type FsckResult,
  type GcOptions,
  type GcResult,
  type StoredAsset,
} from "./service";
