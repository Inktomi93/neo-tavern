import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import { getAppConfig, reloadAppConfig } from "../src/server/config/app-config";
import { createAssetsService } from "../src/server/domain/assets";
import { collectBundlesFromDir, createImportService } from "../src/server/domain/import";
import { env } from "../src/server/env";
import { createCas } from "../src/server/storage/cas";

/**
 * SillyTavern corpus importer (composition-root CLI). Walks a staged profile dir, parses
 * cards + chats, and writes them to the DB idempotently. Run: `pnpm import:st [dir]`
 * (default `corpus-staging/default-user`). Target DB = DATABASE_URL; re-runnable (same
 * importHash → skip), so a partial run is safe to resume. NOT part of `pnpm check`.
 */
async function main(): Promise<void> {
  const dir = process.argv[2] ?? "corpus-staging/default-user";
  console.log(`[import] ${dir} → ${env.DATABASE_URL} (owner: ${env.DEFAULT_USER_HANDLE})`);

  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);
  // Load the effective runtime config (env floor + any admin DB override) so the skip-list honors an
  // admin's stored value, not just the env default — the same resolver the server import path uses.
  await reloadAppConfig(db);
  const svc = createImportService(db, { ownerHandle: env.DEFAULT_USER_HANDLE });
  // The card PNG is the avatar: store it in the CAS and pin the asset onto the version row.
  const assets = createAssetsService(db, createCas(env.ASSETS_DIR));

  const skipNames = getAppConfig().importSkipCharacters;
  const { bundles, orphanChatDirs, unreadableCards, skippedCharacters } =
    await collectBundlesFromDir(dir, skipNames);
  console.log(
    `[import] ${bundles.length} characters · ${orphanChatDirs.length} orphan chat dirs · ${unreadableCards.length} unreadable cards${skippedCharacters.length ? ` · skipped: ${skippedCharacters.join(", ")}` : ""}`,
  );

  const totals = {
    characters: 0,
    versionBumps: 0,
    chats: 0,
    chatsSkipped: 0,
    messages: 0,
    variants: 0,
    worldEntries: 0,
    branches: 0,
  };
  for (const bundle of bundles) {
    if (bundle.card.cardBytes) {
      const stored = await assets.store(bundle.card.cardBytes, "card", "image/png");
      bundle.card.avatarAssetId = stored.assetId;
    }
    const r = await svc.importCharacter(bundle);
    totals.characters += 1;
    if (r.versionBumped) totals.versionBumps += 1;
    totals.chats += r.chatsImported;
    totals.chatsSkipped += r.chatsSkipped;
    totals.messages += r.messagesImported;
    totals.variants += r.variantsImported;
    totals.worldEntries += r.worldEntriesImported;
    totals.branches += r.branchesLinked;
  }

  console.log(
    `[import] ✅ ${totals.characters} characters · ${totals.chats} chats (${totals.chatsSkipped} skipped) · ${totals.messages} messages · ${totals.variants} variants · ${totals.worldEntries} world entries · ${totals.branches} branches linked · ${totals.versionBumps} version bumps`,
  );
  if (orphanChatDirs.length > 0) {
    console.warn(`[import] orphan chat dirs (no matching card): ${orphanChatDirs.join(", ")}`);
  }
  if (unreadableCards.length > 0) {
    console.warn(`[import] unreadable cards: ${unreadableCards.join(", ")}`);
  }
}

await main().catch((error: unknown) => {
  console.error("[import] failed:", error);
  process.exitCode = 1;
});
