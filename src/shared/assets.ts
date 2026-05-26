// Asset addressing — shared across the client/server boundary. An asset is identified by the
// sha-256 hex of its bytes (the CAS key); the app emits `/blob/<hash>` URLs that caddy rewrites
// to the sharded on-disk path (docs/assets.md). Pure string helpers — no I/O, no node deps.

/** The route prefix the client requests and caddy serves (file_server rooted at ASSETS_DIR). */
export const BLOB_ROUTE = "/blob";

/** A content hash is exactly the sha-256 hex digest (64 lowercase hex chars). This is the guard
 *  against path traversal (a hash can't contain `/` or `..`) and a cheap validity check at every
 *  boundary that accepts an external hash. */
export function isAssetHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** The URL the client uses to fetch a blob: `/blob/<hash>`. caddy maps it to the sharded path. */
export function blobUrl(hash: string): string {
  return `${BLOB_ROUTE}/${hash}`;
}

/** The kinds of binary we content-address. `card` = a character-card PNG (also the avatar);
 *  `avatar` = a persona avatar; `export` = a future generated export. */
export type AssetKind = "card" | "avatar" | "export";
