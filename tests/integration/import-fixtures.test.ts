import { resolve } from "node:path";
import { expect, test } from "vitest";
import { characters, characterVersions, chats } from "../../src/db/schema";
import {
  collectBundlesFromDir,
  createImportService,
  type ImportCharacterInput,
  parseCardJson,
} from "../../src/server/domain/import";
import { freshDb } from "../support/db";

// Real SillyTavern export (tests/fixtures/sillytavern) — proves the import domain handles the actual
// on-disk format, not a hand-written approximation. See the fixtures README.
const FIXTURE_DIR = resolve(__dirname, "../fixtures/sillytavern");

function only(bundles: ImportCharacterInput[]): ImportCharacterInput {
  if (bundles.length !== 1) throw new Error(`expected exactly 1 bundle, got ${bundles.length}`);
  const [bundle] = bundles;
  if (!bundle) throw new Error("no bundle");
  return bundle;
}

test("the real Test Character profile imports end-to-end (card + all chats)", async () => {
  const db = await freshDb();
  const { bundles, orphanChatDirs, unreadableCards } = await collectBundlesFromDir(FIXTURE_DIR);

  expect(unreadableCards).toEqual([]); // the card PNG parsed
  expect(orphanChatDirs).toEqual([]); // every chat dir paired to its card
  const bundle = only(bundles);
  expect(bundle.chats).toHaveLength(7); // the 7 fixture chats

  const svc = createImportService(db, { ownerHandle: "owner" });
  const res = await svc.importCharacter(bundle);

  expect(res.characterCreated).toBe(true);
  expect(res.chatsImported).toBe(7);
  const cv = (await db.select().from(characterVersions))[0];
  expect(cv?.name).toBe("Test Character"); // read from the embedded V2/V3 chunk
  expect(await db.select().from(characters)).toHaveLength(1);
  expect(await db.select().from(chats)).toHaveLength(7);
});

test("branch-linking resolves the Branch chat's parent (chat_metadata.main_chat)", async () => {
  const db = await freshDb();
  const { bundles } = await collectBundlesFromDir(FIXTURE_DIR);
  const svc = createImportService(db, { ownerHandle: "owner" });
  const res = await svc.importCharacter(only(bundles));

  // The fixture has a Branch (+ its Checkpoint), each pointing at a parent via main_chat.
  expect(res.branchesLinked).toBeGreaterThanOrEqual(1);
  const linked = await db
    .select({ parentChatId: chats.parentChatId, importedFrom: chats.importedFrom })
    .from(chats);
  const branch = linked.find((c) => (c.importedFrom ?? "").includes("Branch #1.jsonl"));
  expect(branch?.parentChatId).not.toBeNull(); // resolved to the parent chat row
});

test("re-importing the same profile is idempotent (importHash) — no duplicate chats", async () => {
  const db = await freshDb();
  const { bundles } = await collectBundlesFromDir(FIXTURE_DIR);
  const svc = createImportService(db, { ownerHandle: "owner" });
  const bundle = only(bundles);
  await svc.importCharacter(bundle);
  const second = await svc.importCharacter(bundle);

  expect(second.chatsImported).toBe(0); // all matched by importHash
  expect(second.chatsSkipped).toBe(7);
  expect(await db.select().from(chats)).toHaveLength(7); // still 7, not 14
});

test("parseCardJson reads the same card from a bare JSON export (the .json sibling path)", async () => {
  const { bundles } = await collectBundlesFromDir(FIXTURE_DIR);
  // The PNG card's normalized JSON (`raw`) is exactly what an ST "export as JSON" produces — feed it
  // back through parseCardJson and confirm the JSON path yields the same character.
  const fromPng = only(bundles).card.parsed;
  const fromJson = parseCardJson(JSON.stringify(fromPng.raw), "fallback");
  expect(fromJson?.name).toBe(fromPng.name);
  expect(fromJson?.name).toBe("Test Character");
});

test("a skip-list excludes the character (card + its chats dropped)", async () => {
  const { bundles, skippedCharacters } = await collectBundlesFromDir(FIXTURE_DIR, [
    "Test Character",
  ]);
  expect(skippedCharacters).toContain("Test Character");
  expect(bundles).toHaveLength(0); // nothing left to import
});
