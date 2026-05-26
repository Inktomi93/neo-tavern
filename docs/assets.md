# Assets — content-addressed blob store (CAS)

Binary assets (character-card PNGs, persona avatars, future exports) live on the mounted volume in
a **content-addressed store**; the DB holds only metadata. This is the design + the caddy serving
contract. Bytes **never** go in the DB.

## Why a directory, not an object store (decided — don't re-litigate)
Scale here is **~320 small PNGs, one user, one compose image** — a sharded directory is the correct
tier. No MinIO/SeaweedFS/Garage (distributed systems for billions of objects). No CAS npm library
(the only two are unmaintained, untyped — 2014/2020). ~80 lines of our own (`storage/cas.ts`) plus
**one** dependency, `atomically` (TS-native, maintained), for durable atomic writes. The same hash
key ports to S3 unchanged if scale ever demands it, so nothing is lost.

## Layers (enforced)
- **`src/server/storage/cas.ts` — INFRA.** Pure blob I/O keyed by the sha-256 of the bytes; imports
  only `shared` (+ `atomically`, node) — **never `db`** (dependency-cruiser `storage-is-blob-io`).
  Sharded path `<ASSETS_DIR>/<h0:2>/<h2:4>/<hash>` (bare hash, no extension — the hash IS the
  identity). Durable atomic write: a temp under `<ASSETS_DIR>/.tmp/` (same filesystem — a
  cross-device `/tmp` rename silently degrades to a non-atomic copy) → fsync → rename into the
  shard. Write-once dedup: identical bytes hash identically, so the second `putBytes` is a no-op.
- **`src/server/domain/assets/` — DOMAIN.** Orchestrates the CAS with the `assets` index rows and
  the avatar refs: `store`, `backfillAvatars`, `collectGarbage`, `fsck`, `rebuildFromTree`.
- **`scripts/assets-{backfill,gc,fsck}.ts` — composition-root CLIs** (wire a `Cas` + `Db` + the
  domain service; `jobs/` can't import `db` under `drivers-through-domain`). `pnpm assets:backfill
  [profileDir]` · `pnpm assets:gc [graceMinutes]` · `pnpm assets:fsck [--rebuild]`.
- **`ASSETS_DIR`** (env) is the blob root — a path on the mounted volume in prod; dev default sits
  under the gitignored `data/`.

## DB shape (migration 0016)
- **`assets`** (global — **NO `ownerId`**; binaries dedup by hash): `id`, `kind`
  (`card`|`avatar`|`export`), `mime`, `size`, `hash` (unique), `uploadedAt`. **No `path`** (the
  locator is `cas.blobPath(hash)` — a moved/re-rooted volume needs no DB rewrite). **No refcount**
  (refcounts drift — GC is mark-sweep).
- **`character_versions.avatarAssetId` / `personas.avatarAssetId`** → `assets.id` **ON DELETE SET
  NULL** (the FKs 0007 skipped while assets were unused). The card PNG **is** the avatar — one
  blob, both roles; don't double-store.
- **`image_embeddings`** — a **separate vector space + dimension** from the 1024-dim BGE-M3 text
  `embeddings` (do NOT reuse that column/index). SigLIP-2 so400m → `F32_BLOB(1152)` +
  `libsql_vector_idx` (`image_embeddings_ann`, hand-added in the migration). **Landing table only**
  — running the embed pass is a follow-up; embed FROM the blob by hash. Footgun: a bulk
  `DELETE FROM` empties the table and poisons the shadow index → `REINDEX image_embeddings_ann`.

## hash == importHash (the built-in integrity check)
A card blob's sha-256 **is** `characters.importHash` (both hash the whole PNG file), so the forward
import path and the backfill share one check: the stored hash must equal the recorded `importHash`.
`backfillAvatars` records a `mismatch` (and refuses to link) when they differ — the on-disk PNG
isn't the card that was imported.

## Wiring the avatar
- **Forward (new imports):** `scripts/import-st.ts` stores each card PNG via `assets.store(...,
  'card', 'image/png')` and sets `character_versions.avatarAssetId`. (`domain/import` can't import
  `domain/assets` — cross-feature — so the store happens in the CLI that wires both.)
- **Backfill (already-imported corpus):** a plain re-`import:st` is a no-op for unchanged cards, so
  it will NOT add avatars retroactively. `pnpm assets:backfill` re-pairs the staged profile's PNGs
  to characters via the **same loader** (`collectBundlesFromDir`/`slugifyHandle`), stores them, and
  links `avatarAssetId`. Idempotent (already-linked versions are skipped). The owner runs this
  against the real volume; it's fixture-tested here.

## GC — mark-sweep with a grace window
Referenced set = every asset reachable via a `character_versions`/`personas` `avatarAssetId`.
On-disk blobs **not** in that set are orphans → swept, **except** blobs younger than the grace
window (default 1h), so GC can't race an in-flight import that stored a blob before linking it.
A swept orphan's `assets` row is deleted too (no dangling row left behind). Manual/scheduled, never
automatic.

## fsck
Per `assets` row: assert the blob **exists** and **re-hashes** to its name. Reports **dangling**
(row, no blob), **corrupt** (blob ≠ hash), and **orphan** (blob on disk, no row). `--rebuild`
re-derives rows for orphan blobs (DR — walk + hash the tree, sniff the mime).

## URL contract + caddy serving (PREPARED, not load-tested)
The app emits **`/blob/<hash>`** URLs (`shared/assets.ts` `blobUrl` — unit-tested). caddy serves
the blobs statically off `ASSETS_DIR`, rewriting the hash to its sharded path. Content-addressed ⇒
immutable ⇒ a year-long immutable cache. **Don't expose this to an untrusted network** — same
header-trust invariant as the rest of the app (authentik + caddy in front; port 8788 stays
internal).

```caddy
# Static, immutable blob serving. Blobs are content-addressed and stored bare (no extension) at
# <ASSETS_DIR>/<h0:2>/<h2:4>/<hash>. `root` must point at ASSETS_DIR on the mounted volume.
@blob path_regexp blob ^/blob/(([0-9a-f]{2})([0-9a-f]{2})[0-9a-f]{60})$
handle @blob {
	root * /srv/assets
	rewrite * /{re.blob.2}/{re.blob.3}/{re.blob.1}
	header Cache-Control "public, max-age=31536000, immutable"
	file_server
}
```

**Content-Type caveat (resolve when the avatar UI lands, not now):** blobs are stored without an
extension (the hash is the identity), so `file_server` can't infer a MIME type from the filename —
it serves `application/octet-stream`. Two options, deferred: (a) add `header Content-Type image/png`
to the block (every current asset is a PNG), or (b) serve `/blob/:hash` from the app, which knows
the row's `mime`. The canonical CAS tree stays bare-hash either way. Acceptance for this task is
**config committed + contract documented + the `blobUrl` helper unit-tested** — no live request.
