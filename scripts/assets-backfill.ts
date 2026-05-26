import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import { ensureUser } from "../src/server/domain/_shared/users";
import { type BackfillCard, createAssetsService } from "../src/server/domain/assets";
import { collectBundlesFromDir } from "../src/server/domain/import";
import { env } from "../src/server/env";
import { createCas } from "../src/server/storage/cas";

/**
 * Avatar backfill (composition-root CLI). The importer's "unchanged ⇒ no-op" short-circuit means a
 * plain re-import:st does NOT add avatars to characters imported before the CAS landed — this pass
 * does. It re-pairs the staged profile's card PNGs to characters via the SAME loader (so the
 * handle↔card mapping is identical to import), stores each as the avatar asset, and sets
 * character_versions.avatarAssetId. Idempotent (already-linked versions are skipped) and independent
 * of import. Run: `pnpm assets:backfill [profileDir]` (default `corpus-staging/default-user`, or
 * ST_DATA_DIR). The OWNER runs this against the real volume; here it's fixture-tested.
 */
async function main(): Promise<void> {
  const dir = process.argv[2] ?? process.env["ST_DATA_DIR"] ?? "corpus-staging/default-user";
  console.log(`[assets:backfill] ${dir} → ${env.DATABASE_URL} (owner: ${env.DEFAULT_USER_HANDLE})`);

  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);
  const assets = createAssetsService(db, createCas(env.ASSETS_DIR));
  const ownerId = await ensureUser(db, env.DEFAULT_USER_HANDLE);

  const { bundles } = await collectBundlesFromDir(dir);
  const cards: BackfillCard[] = [];
  for (const b of bundles) {
    if (b.card.cardBytes) cards.push({ handle: b.card.handle, bytes: b.card.cardBytes });
  }

  const r = await assets.backfillAvatars(ownerId, cards);
  console.log(
    `[assets:backfill] ✅ ${r.linked} avatars linked · ${r.skipped} skipped (already linked / no character)${r.mismatches.length > 0 ? ` · ⚠ ${r.mismatches.length} hash mismatches: ${r.mismatches.join(", ")}` : ""}`,
  );
}

await main().catch((error: unknown) => {
  console.error("[assets:backfill] failed:", error);
  process.exitCode = 1;
});
