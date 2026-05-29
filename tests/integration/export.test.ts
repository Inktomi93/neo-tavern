import type { Buffer } from "node:buffer";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { messages as messagesTable, messageVariants } from "../../src/db/schema";
import { newId } from "../../src/server/domain/_shared/ids";
import { ensureUser } from "../../src/server/domain/_shared/users";
import { createCharacterService } from "../../src/server/domain/character";
import { createChatService } from "../../src/server/domain/chat";
import { buildCardV3 } from "../../src/server/domain/export/card";
import { buildChatJsonl, type ExportMessage } from "../../src/server/domain/export/chat";
import { embedCardChunk } from "../../src/server/domain/export/png";
import { createExportService } from "../../src/server/domain/export/service";
import { parseCardPng } from "../../src/server/domain/import/card";
import { parseChatJsonl } from "../../src/server/domain/import/chat";
import { createCas } from "../../src/server/storage/cas";
import { freshDb } from "../support/db";

// Export ↔ import symmetry: the existing import parsers are the oracle. Whatever we export must
// re-parse to the same data — that's the spec these builders target.

const basePng = (): Promise<Buffer> =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();

test("character PNG export round-trips through the card parser (live fields, no `raw`)", async () => {
  const png = embedCardChunk(
    new Uint8Array(await basePng()),
    buildCardV3(
      {
        name: "Vermithrax",
        description: "an ancient dragon",
        personality: "proud, territorial",
        scenario: "guarding the northern pass",
        greetings: ["Hail, traveler.", "You again?"],
        exampleMessages: "<START>\n{{user}}: hi\n{{char}}: *roars*",
        systemPrompt: "Stay in character.",
        postHistoryInstructions: "Never break character.",
        creatorNotes: "be dramatic",
        tags: ["fantasy", "dragon"],
      },
      [
        {
          keys: ["pass", "gate"],
          content: "The pass is guarded year-round.",
          enabled: true,
          priority: 5,
        },
      ],
    ),
  );

  const parsed = parseCardPng(png, "fallback");
  if (parsed === null) throw new Error("export PNG did not re-parse");
  expect(parsed.name).toBe("Vermithrax");
  expect(parsed.description).toBe("an ancient dragon");
  expect(parsed.firstMessage).toBe("Hail, traveler."); // greetings[0]
  expect(parsed.alternateGreetings).toEqual(["You again?"]); // greetings[1:]
  expect(parsed.exampleMessages).toBe("<START>\n{{user}}: hi\n{{char}}: *roars*");
  expect(parsed.systemPrompt).toBe("Stay in character.");
  expect(parsed.postHistoryInstructions).toBe("Never break character.");
  expect(parsed.tags).toEqual(["fantasy", "dragon"]);
  expect(parsed.lorebookEntries).toHaveLength(1);
  expect(parsed.lorebookEntries[0]?.["content"]).toBe("The pass is guarded year-round.");
  expect(parsed.lorebookEntries[0]?.["keys"]).toEqual(["pass", "gate"]);
});

test("embedding a second card replaces the first (no duplicate chunk)", async () => {
  const once = embedCardChunk(new Uint8Array(await basePng()), buildCardV3(card("First"), []));
  const twice = embedCardChunk(once, buildCardV3(card("Second"), []));
  const parsed = parseCardPng(twice, "fallback");
  expect(parsed?.name).toBe("Second"); // latest wins; the reader finds exactly one ccv3
});

test("embedCardChunk rejects a non-PNG base", async () => {
  expect(() => embedCardChunk(new Uint8Array([1, 2, 3, 4]), buildCardV3(card("X"), []))).toThrow();
});

function card(name: string) {
  return {
    name,
    description: null,
    personality: null,
    scenario: null,
    greetings: [],
    exampleMessages: null,
    systemPrompt: null,
    postHistoryInstructions: null,
    creatorNotes: null,
    tags: [],
  };
}

test("chat JSONL export round-trips through the chat parser, including swipes", async () => {
  const now = 1_780_000_000_000;
  const messages: ExportMessage[] = [
    {
      role: "user",
      content: "tell me about the pass",
      sendDate: now,
      model: null,
      provider: null,
      tokensOut: null,
      genStarted: null,
      genFinished: null,
      activeVariantIdx: null,
      variants: [],
    },
    {
      role: "assistant",
      content: "the second swipe",
      sendDate: now + 1000,
      model: "claude-opus-4-7",
      provider: "agent-sdk",
      tokensOut: 42,
      genStarted: now,
      genFinished: now + 1000,
      activeVariantIdx: 1,
      variants: [
        {
          content: "the first swipe",
          model: "claude-opus-4-7",
          provider: "agent-sdk",
          tokensOut: 40,
          genStarted: now,
          genFinished: now,
        },
        {
          content: "the second swipe",
          model: "claude-opus-4-7",
          provider: "agent-sdk",
          tokensOut: 42,
          genStarted: now,
          genFinished: now + 1000,
        },
      ],
    },
  ];
  const jsonl = buildChatJsonl(
    {
      characterName: "Vermithrax",
      userName: "Inktomi",
      createDate: now,
      notePrompt: "stay in character",
    },
    messages,
  );

  const parsed = parseChatJsonl(jsonl, {
    fileName: "Vermithrax - main.jsonl",
    charDirName: "Vermithrax",
  });
  if (parsed === null) throw new Error("export JSONL did not re-parse");
  expect(parsed.characterName).toBe("Vermithrax");
  expect(parsed.userName).toBe("Inktomi");
  expect(parsed.notePrompt).toBe("stay in character");
  expect(parsed.createDate).toBe(now);
  expect(parsed.messages).toHaveLength(2);

  expect(parsed.messages[0]?.role).toBe("user");
  expect(parsed.messages[0]?.content).toBe("tell me about the pass");
  expect(parsed.messages[0]?.variants).toHaveLength(0); // single generation → no swipes

  const asst = parsed.messages[1];
  expect(asst?.role).toBe("assistant");
  expect(asst?.content).toBe("the second swipe");
  expect(asst?.model).toBe("claude-opus-4-7");
  expect(asst?.provider).toBe("agent-sdk");
  expect(asst?.tokensOut).toBe(42);
  expect(asst?.activeVariantIdx).toBe(1);
  expect(asst?.variants).toHaveLength(2);
  expect(asst?.variants[0]?.content).toBe("the first swipe");
  expect(asst?.variants[1]?.content).toBe("the second swipe");
});

// ── service: DB → export → re-parse (the column mapping, end-to-end) ──────────

async function tmpCas() {
  return createCas(await mkdtemp(join(tmpdir(), "neo-export-")));
}

test("exportCharacter reads live DB fields and produces a parseable card", async () => {
  const db = await freshDb();
  const ownerId = await ensureUser(db, "owner");
  const created = await createCharacterService(db).create(
    { username: "owner" },
    {
      handle: "vermithrax",
      name: "Vermithrax",
      description: "an ancient dragon",
      personality: "proud",
      scenario: "the pass",
      greetings: ["Hail.", "Alt greeting."],
      systemPrompt: "Stay in character.",
      tags: ["dragon"],
    },
  );

  const out = await createExportService(db, await tmpCas()).exportCharacter(ownerId, created.id);
  if (!out) throw new Error("export returned null");
  expect(out.filename).toBe("Vermithrax.png");
  const parsed = parseCardPng(out.bytes, "fallback");
  if (parsed === null) throw new Error("export PNG did not re-parse");
  expect(parsed.name).toBe("Vermithrax");
  expect(parsed.description).toBe("an ancient dragon");
  expect(parsed.firstMessage).toBe("Hail.");
  expect(parsed.alternateGreetings).toEqual(["Alt greeting."]);
  expect(parsed.tags).toEqual(["dragon"]);
});

test("exportCharacter is owner-scoped (a different owner gets null)", async () => {
  const db = await freshDb();
  await ensureUser(db, "owner");
  const intruderId = await ensureUser(db, "intruder");
  const created = await createCharacterService(db).create(
    { username: "owner" },
    { handle: "x", name: "X", description: "d" },
  );
  expect(
    await createExportService(db, await tmpCas()).exportCharacter(intruderId, created.id),
  ).toBeNull();
});

test("exportChat reads messages + variants and round-trips through the chat parser", async () => {
  const db = await freshDb();
  const ownerId = await ensureUser(db, "owner");
  const { chatId } = await createChatService(db).create({
    username: "owner",
    title: "Origin",
    characterName: "Vermithrax",
    characterDescription: "a dragon",
  });

  const now = Date.now();
  const asstId = newId();
  await db
    .insert(messagesTable)
    .values({ id: newId(), chatId, seq: 1, role: "user", content: "hello there", createdAt: now });
  await db.insert(messagesTable).values({
    id: asstId,
    chatId,
    seq: 2,
    role: "assistant",
    content: "the second swipe",
    model: "claude-opus-4-7",
    provider: "agent-sdk",
    tokensOut: 5,
    activeVariantIdx: 1,
    createdAt: now + 1,
  });
  await db
    .insert(messageVariants)
    .values({ id: newId(), messageId: asstId, idx: 0, content: "the first swipe", createdAt: now });
  await db.insert(messageVariants).values({
    id: newId(),
    messageId: asstId,
    idx: 1,
    content: "the second swipe",
    model: "claude-opus-4-7",
    provider: "agent-sdk",
    tokensOut: 5,
    createdAt: now + 1,
  });

  const out = await createExportService(db, await tmpCas()).exportChat(ownerId, chatId);
  if (!out) throw new Error("export returned null");
  const parsed = parseChatJsonl(out.text, { fileName: out.filename, charDirName: "Vermithrax" });
  if (parsed === null) throw new Error("export JSONL did not re-parse");
  expect(parsed.characterName).toBe("Vermithrax");
  expect(parsed.messages).toHaveLength(2);
  expect(parsed.messages[0]?.content).toBe("hello there");
  expect(parsed.messages[1]?.content).toBe("the second swipe");
  expect(parsed.messages[1]?.activeVariantIdx).toBe(1);
  expect(parsed.messages[1]?.variants).toHaveLength(2);
  expect(parsed.messages[1]?.variants[0]?.content).toBe("the first swipe");
});
