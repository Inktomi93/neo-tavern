import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { assets, characters, characterVersions } from "../../src/db/schema";
import { ensureUser } from "../../src/server/domain/_shared/users";
import { createAssetsService } from "../../src/server/domain/assets";
import { collectBundlesFromDir, createImportService } from "../../src/server/domain/import";
import { createCas } from "../../src/server/storage/cas";
import { freshDb } from "../support/db";

const cardPng = fileURLToPath(
  new URL("../fixtures/corpus/characters/Block of Cheese.png", import.meta.url),
);

let casRoot: string;
beforeEach(async () => {
  casRoot = await mkdtemp(join(tmpdir(), "neo-assets-"));
});
afterEach(async () => {
  await rm(casRoot, { recursive: true, force: true });
});

// A temp ST profile with the fixture card copied under N distinct names → N characters that share
// identical card bytes (so the dedup → one-blob-many-refs path can be exercised end to end).
async function profileWithCards(names: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neo-profile-"));
  await mkdir(join(dir, "characters"), { recursive: true });
  const bytes = await readFile(cardPng);
  for (const n of names) await writeFile(join(dir, "characters", `${n}.png`), bytes);
  return dir;
}

test("ingest: identical card bytes dedup to ONE blob with TWO version refs; hash == importHash", async () => {
  const db = await freshDb();
  const cas = createCas(casRoot);
  const assetsSvc = createAssetsService(db, cas);
  const importSvc = createImportService(db, { ownerHandle: "owner" });

  const profile = await profileWithCards(["Block of Cheese", "Cheese Twin"]);
  try {
    const { bundles } = await collectBundlesFromDir(profile);
    expect(bundles).toHaveLength(2);

    for (const b of bundles) {
      const bytes = b.card.cardBytes;
      if (!bytes) throw new Error("loader should carry cardBytes");
      const stored = await assetsSvc.store(bytes, "card", "image/png");
      b.card.avatarAssetId = stored.assetId;
      await importSvc.importCharacter(b);
    }

    // ONE asset row + ONE blob despite two characters.
    const rows = await db.select().from(assets);
    expect(rows).toHaveLength(1);
    const blobs: string[] = [];
    for await (const h of cas.listHashes()) blobs.push(h);
    expect(blobs).toEqual([rows[0]?.hash]);

    // Both versions point at that one asset…
    const versions = await db.select().from(characterVersions);
    expect(versions).toHaveLength(2);
    for (const v of versions) expect(v.avatarAssetId).toBe(rows[0]?.id);

    // …and the asset hash equals each character's importHash (built-in integrity check).
    const chars = await db.select().from(characters);
    for (const c of chars) expect(c.importHash).toBe(rows[0]?.hash);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("backfill: links avatars for already-imported characters and is idempotent", async () => {
  const db = await freshDb();
  const assetsSvc = createAssetsService(db, createCas(casRoot));
  const importSvc = createImportService(db, { ownerHandle: "owner" });
  const ownerId = await ensureUser(db, "owner");

  // Import WITHOUT storing avatars (the pre-CAS state) → versions have no avatarAssetId.
  const profile = await profileWithCards(["Block of Cheese"]);
  try {
    const { bundles } = await collectBundlesFromDir(profile);
    for (const b of bundles) await importSvc.importCharacter(b);
    const before = (await db.select().from(characterVersions))[0];
    expect(before?.avatarAssetId).toBeNull();

    const cards = bundles.map((b) => ({
      handle: b.card.handle,
      bytes: b.card.cardBytes ?? new Uint8Array(),
    }));
    const first = await assetsSvc.backfillAvatars(ownerId, cards);
    expect(first.linked).toBe(1);
    expect(first.mismatches).toEqual([]);

    const after = (await db.select().from(characterVersions))[0];
    expect(after?.avatarAssetId).not.toBeNull();
    const asset = (await db.select().from(assets))[0];
    expect(after?.avatarAssetId).toBe(asset?.id);

    // Idempotent: a second run links nothing.
    const second = await assetsSvc.backfillAvatars(ownerId, cards);
    expect(second.linked).toBe(0);
    expect(second.skipped).toBe(1);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("gc: sweeps an orphan blob but honors the grace window; keeps referenced blobs", async () => {
  const db = await freshDb();
  const cas = createCas(casRoot);
  const assetsSvc = createAssetsService(db, cas);
  const importSvc = createImportService(db, { ownerHandle: "owner" });

  // A referenced asset (linked to an imported character) + an unreferenced orphan.
  const profile = await profileWithCards(["Block of Cheese"]);
  try {
    const { bundles } = await collectBundlesFromDir(profile);
    const b = bundles[0];
    if (!b?.card.cardBytes) throw new Error("expected a card bundle");
    const referenced = await assetsSvc.store(b.card.cardBytes, "card", "image/png");
    b.card.avatarAssetId = referenced.assetId;
    await importSvc.importCharacter(b);

    const orphan = await assetsSvc.store(
      new TextEncoder().encode("orphan blob"),
      "avatar",
      "image/png",
    );

    const now = Date.now();
    // Within grace: nothing swept (the orphan is too young to risk racing an import).
    const kept = await assetsSvc.collectGarbage({ graceMs: 60_000, now });
    expect(kept.removed).toBe(0);
    expect(kept.keptReferenced).toBe(1);
    expect(kept.keptWithinGrace).toBe(1);
    expect(await cas.exists(orphan.hash)).toBe(true);

    // Past grace (clock advanced an hour): the orphan is swept, the referenced blob survives.
    const swept = await assetsSvc.collectGarbage({ graceMs: 60_000, now: now + 3_600_000 });
    expect(swept.removed).toBe(1);
    expect(swept.keptReferenced).toBe(1);
    expect(await cas.exists(orphan.hash)).toBe(false);
    expect(await cas.exists(referenced.hash)).toBe(true);
    // The swept blob's row is gone too (no dangling row left behind).
    expect(await db.select().from(assets).where(eq(assets.hash, orphan.hash))).toHaveLength(0);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("fsck: reports dangling (row, no blob) and orphan (blob, no row)", async () => {
  const db = await freshDb();
  const cas = createCas(casRoot);
  const assetsSvc = createAssetsService(db, cas);

  const healthy = await assetsSvc.store(new TextEncoder().encode("healthy"), "card", "image/png");

  // Dangling: a row whose blob we delete out from under it.
  const dangling = await assetsSvc.store(new TextEncoder().encode("dangling"), "card", "image/png");
  await cas.remove(dangling.hash);

  // Orphan: a blob with no row (written straight to the CAS).
  const orphan = await cas.putBytes(new TextEncoder().encode("orphan"));

  const r = await assetsSvc.fsck();
  expect(r.ok).toBe(1);
  expect(r.dangling).toEqual([dangling.hash]);
  expect(r.orphans).toEqual([orphan.hash]);
  expect(r.corrupt).toEqual([]);
  expect(await cas.verify(healthy.hash)).toBe(true);
});
