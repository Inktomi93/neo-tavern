import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { characters, chats, messages, messageVariants } from "../../src/db/schema";
import { collectBundlesFromDir, createImportService } from "../../src/server/domain/import";
import { freshDb } from "../support/db";

const corpusDir = fileURLToPath(new URL("../fixtures/corpus", import.meta.url));

test("collectBundlesFromDir pairs a card with chats across case-variant dirs", async () => {
  const { bundles, orphanChatDirs, unreadableCards } = await collectBundlesFromDir(corpusDir);

  expect(orphanChatDirs).toEqual([]);
  expect(unreadableCards).toEqual([]);
  // "Block of Cheese" + "Block Of Cheese" dirs collapse onto one character.
  expect(bundles).toHaveLength(1);
  const b = bundles[0];
  expect(b?.card.handle).toBe("block-of-cheese");
  expect(b?.card.parsed.name).toBe("Block of Cheese");
  expect(b?.card.importHash).toMatch(/^[0-9a-f]{64}$/); // sha-256 hex
  expect(b?.chats).toHaveLength(2); // main + branch
  // each chat carries its own content hash + source filename
  const files = b?.chats.map((c) => c.importedFrom).sort();
  expect(files).toEqual(["main - Branch #1.jsonl", "main.jsonl"]);
});

test("skip-list excludes a character (card + all its chats) case-insensitively, with no orphans", async () => {
  const { bundles, orphanChatDirs, skippedCharacters } = await collectBundlesFromDir(corpusDir, [
    "BLOCK OF CHEESE", // case-insensitive match on the card name
  ]);
  expect(bundles).toHaveLength(0); // the only character is skipped
  expect(skippedCharacters).toEqual(["Block of Cheese"]);
  expect(orphanChatDirs).toEqual([]); // its chats are dropped by handle, not left as orphans
});

test("end-to-end: collect → import writes the character, chats, variants, and links the branch", async () => {
  const db = await freshDb();
  const svc = createImportService(db, { ownerHandle: "owner" });
  const { bundles } = await collectBundlesFromDir(corpusDir);
  const bundle = bundles[0];
  if (!bundle) throw new Error("expected one bundle from the fixture corpus");
  const res = await svc.importCharacter(bundle);

  expect(res.characterCreated).toBe(true);
  expect(res.chatsImported).toBe(2);
  expect(res.branchesLinked).toBe(1);
  expect(res.variantsImported).toBe(2); // the swiped assistant message

  expect(await db.select().from(characters)).toHaveLength(1);

  const main = (await db.select().from(chats).where(eq(chats.importedFrom, "main.jsonl")))[0];
  const branch = (
    await db.select().from(chats).where(eq(chats.importedFrom, "main - Branch #1.jsonl"))
  )[0];
  expect(branch?.parentChatId).toBe(main?.id); // cross-dir branch resolved to its parent

  // the swiped message: content = mes, variants verbatim with per-swipe model
  const mainMsgs = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, main?.id ?? ""));
  const swiped = mainMsgs.find((m) => m.activeVariantIdx !== null);
  expect(swiped?.content).toBe("It crumbles politely.");
  const variants = await db
    .select()
    .from(messageVariants)
    .where(eq(messageVariants.messageId, swiped?.id ?? ""));
  expect(variants.map((v) => v.model).sort()).toEqual(["opus", "sonnet"]);
});
