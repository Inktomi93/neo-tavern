import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import {
  characters,
  characterVersions,
  characterVersionWorldEntries,
  chats,
  messages,
  messageVariants,
  worldEntries,
} from "../../src/db/schema";
import type {
  ImportCharacterInput,
  ParsedCard,
  ParsedChat,
  ParsedChatMessage,
} from "../../src/server/domain/import";
import { createImportService, slugifyHandle } from "../../src/server/domain/import";
import { freshDb } from "../support/db";

const OWNER = "owner";

function card(o: Partial<ParsedCard> = {}): ParsedCard {
  return {
    name: "Cheese",
    description: "a block of cheese",
    personality: null,
    scenario: null,
    firstMessage: null,
    exampleMessages: null,
    systemPrompt: null,
    postHistoryInstructions: null,
    creator: null,
    creatorNotes: null,
    alternateGreetings: [],
    tags: [],
    cardVersion: null,
    lorebookEntries: [],
    raw: { spec: "chara_card_v2" },
    ...o,
  };
}
function msg(o: Partial<ParsedChatMessage> = {}): ParsedChatMessage {
  return {
    role: "assistant",
    content: "hi",
    sendDate: 1000,
    model: null,
    provider: null,
    tokensOut: null,
    genStarted: null,
    genFinished: null,
    activeVariantIdx: null,
    variants: [],
    raw: {},
    ...o,
  };
}
function chat(o: Partial<ParsedChat> = {}): ParsedChat {
  return {
    characterName: "Cheese",
    userName: "Nate",
    createDate: 1000,
    isBranch: false,
    parentRef: null,
    notePrompt: null,
    bucket: "real_conversation",
    messages: [msg()],
    rawHeader: {},
    ...o,
  };
}
function bundle(o: Partial<ImportCharacterInput> = {}): ImportCharacterInput {
  return {
    card: {
      handle: slugifyHandle("Cheese"),
      parsed: card(),
      importedFrom: "Cheese.png",
      importHash: "card-h1",
    },
    chats: [{ parsed: chat(), importedFrom: "Cheese - a.jsonl", importHash: "chat-a" }],
    ...o,
  };
}

test("slugifyHandle collapses ST case-variant dirs onto one character", () => {
  expect(slugifyHandle("Block of Cheese")).toBe(slugifyHandle("Block Of Cheese"));
  expect(slugifyHandle("Block of Cheese")).toBe("block-of-cheese");
});

test("fresh import creates character + version 1 + chat + messages + variants", async () => {
  const db = await freshDb();
  const svc = createImportService(db, { ownerHandle: OWNER });
  const res = await svc.importCharacter(
    bundle({
      chats: [
        {
          parsed: chat({
            messages: [
              msg({ role: "user", content: "hello" }),
              msg({
                role: "assistant",
                content: "EDITED",
                activeVariantIdx: 1,
                variants: [
                  {
                    idx: 0,
                    content: "gen0",
                    model: "opus",
                    provider: "anthropic",
                    tokensOut: 5,
                    genStarted: 1,
                    genFinished: 2,
                  },
                  {
                    idx: 1,
                    content: "gen1",
                    model: "sonnet",
                    provider: "anthropic",
                    tokensOut: 6,
                    genStarted: null,
                    genFinished: null,
                  },
                ],
              }),
            ],
          }),
          importedFrom: "Cheese - a.jsonl",
          importHash: "chat-a",
        },
      ],
    }),
  );

  expect(res.characterCreated).toBe(true);
  expect(res.chatsImported).toBe(1);
  expect(res.messagesImported).toBe(2);
  expect(res.variantsImported).toBe(2);

  const chr = (await db.select().from(characters).where(eq(characters.handle, "cheese")))[0];
  expect(chr?.currentVersionId).toBe(res.versionId);
  const vers = await db
    .select()
    .from(characterVersions)
    .where(eq(characterVersions.characterId, res.characterId));
  expect(vers).toHaveLength(1);
  expect(vers[0]?.version).toBe(1);

  const chatRow = (await db.select().from(chats))[0];
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatRow?.id ?? ""));
  expect(msgs.map((m) => m.seq)).toEqual([0, 1]); // monotonic
  const active = msgs.find((m) => m.role === "assistant");
  expect(active?.content).toBe("EDITED"); // rendered text, not the swipe
  expect(active?.activeVariantIdx).toBe(1);
  const variants = await db
    .select()
    .from(messageVariants)
    .where(eq(messageVariants.messageId, active?.id ?? ""));
  expect(variants).toHaveLength(2);
  expect(variants.find((v) => v.idx === 0)?.model).toBe("opus");
});

test("lorebook → world_book + entries + cv junction", async () => {
  const db = await freshDb();
  const svc = createImportService(db, { ownerHandle: OWNER });
  const res = await svc.importCharacter(
    bundle({
      card: {
        handle: slugifyHandle("Cheese"),
        parsed: card({
          lorebookEntries: [
            {
              keys: ["castle"],
              content: "castle lore",
              enabled: true,
              insertion_order: 5,
              comment: "The Castle",
            },
            { keys: ["king"], content: "king lore", enabled: false },
          ],
        }),
        importedFrom: "Cheese.png",
        importHash: "card-h1",
      },
    }),
  );
  expect(res.worldEntriesImported).toBe(2);
  const entries = await db.select().from(worldEntries);
  expect(entries).toHaveLength(2);
  const castle = entries.find((e) => e.title === "The Castle");
  expect(castle?.content).toBe("castle lore");
  expect(castle?.priority).toBe(5);
  expect(entries.find((e) => e.content === "king lore")?.enabled).toBe(false); // disabled kept
  const junctions = await db
    .select()
    .from(characterVersionWorldEntries)
    .where(eq(characterVersionWorldEntries.characterVersionId, res.versionId));
  expect(junctions).toHaveLength(2);
});

test("branch resolution links parentChatId character-wide (incl. parent from a prior call)", async () => {
  const db = await freshDb();
  const svc = createImportService(db, { ownerHandle: OWNER });
  // First run: the parent (main) chat only.
  await svc.importCharacter(
    bundle({
      chats: [{ parsed: chat(), importedFrom: "Cheese - main.jsonl", importHash: "chat-main" }],
    }),
  );
  // Second run (same character): a branch pointing at the parent imported earlier.
  const res = await svc.importCharacter(
    bundle({
      chats: [
        {
          parsed: chat({ isBranch: true, parentRef: "Cheese - main.jsonl" }),
          importedFrom: "Cheese - main - Branch #1.jsonl",
          importHash: "chat-branch",
        },
      ],
    }),
  );
  expect(res.branchesLinked).toBe(1);
  const parent = (await db.select().from(chats).where(eq(chats.importHash, "chat-main")))[0];
  const branch = (await db.select().from(chats).where(eq(chats.importHash, "chat-branch")))[0];
  expect(branch?.parentChatId).toBe(parent?.id);
  expect(branch?.forkedAt).not.toBeNull();
});

test("re-import is idempotent: same hashes → no new rows, chats skipped", async () => {
  const db = await freshDb();
  const svc = createImportService(db, { ownerHandle: OWNER });
  await svc.importCharacter(bundle());
  const res2 = await svc.importCharacter(bundle());

  expect(res2.characterCreated).toBe(false);
  expect(res2.versionBumped).toBe(false);
  expect(res2.chatsImported).toBe(0);
  expect(res2.chatsSkipped).toBe(1);
  expect(await db.select().from(characters)).toHaveLength(1);
  expect(await db.select().from(characterVersions)).toHaveLength(1);
  expect(await db.select().from(chats)).toHaveLength(1);
  expect(await db.select().from(messages)).toHaveLength(1);
});

test("changed card → new version (copy-on-write); old chat stays pinned to v1", async () => {
  const db = await freshDb();
  const svc = createImportService(db, { ownerHandle: OWNER });
  const first = await svc.importCharacter(bundle());
  const v1 = first.versionId;

  const res2 = await svc.importCharacter(
    bundle({
      card: {
        handle: slugifyHandle("Cheese"),
        parsed: card({ description: "edited card" }),
        importedFrom: "Cheese.png",
        importHash: "card-h2",
      },
      chats: [{ parsed: chat(), importedFrom: "Cheese - b.jsonl", importHash: "chat-b" }],
    }),
  );

  expect(res2.versionBumped).toBe(true);
  expect(res2.versionId).not.toBe(v1);
  const vers = await db
    .select()
    .from(characterVersions)
    .where(eq(characterVersions.characterId, first.characterId));
  expect(vers.map((v) => v.version).sort()).toEqual([1, 2]);
  const chr = (await db.select().from(characters).where(eq(characters.id, first.characterId)))[0];
  expect(chr?.currentVersionId).toBe(res2.versionId); // advanced

  // the first chat stays pinned to v1; the new chat pins v2
  const chatA = (await db.select().from(chats).where(eq(chats.importHash, "chat-a")))[0];
  const chatB = (await db.select().from(chats).where(eq(chats.importHash, "chat-b")))[0];
  expect(chatA?.characterVersionId).toBe(v1);
  expect(chatB?.characterVersionId).toBe(res2.versionId);
});
