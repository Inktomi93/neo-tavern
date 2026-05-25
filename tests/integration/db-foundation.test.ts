import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { Db } from "../../src/db/client";
import {
  characters,
  characterVersions,
  chats,
  chatWorldEntries,
  messages,
  messageVariants,
  personas,
  presets,
  presetVersions,
  sessionEntries,
  users,
  worldBooks,
  worldEntries,
} from "../../src/db/schema";
import { freshDb } from "../support/db";

// Wiring smoke test (NOT a schema tautology): proves the migration applies, a row
// round-trips, and the foreign_keys PRAGMA actually took effect.
test("migrations apply and a user round-trips", async () => {
  const db = await freshDb();

  await db.insert(users).values({ id: "u1", handle: "owner", createdAt: Date.now() });
  const rows = await db.select().from(users).where(eq(users.handle, "owner"));

  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe("u1");
});

test("foreign_keys PRAGMA is enforced (the load-bearing one)", async () => {
  const db = await freshDb();

  // personas.ownerId references users.id — a dangling owner must be rejected. If this
  // passes, PRAGMA foreign_keys = ON did NOT take effect.
  await expect(
    db
      .insert(personas)
      .values({ id: "p1", ownerId: "ghost", name: "x", description: "y", createdAt: Date.now() }),
  ).rejects.toThrow();
});

// ───────────────────── Migration 0007: relational FK integrity ─────────────────────
const NOW = 1_700_000_000_000;

// A character (id "c") + version "cv" (currentVersionId repointed) + chat "ch" pinning it.
async function seedCharacterAndChat(db: Db): Promise<void> {
  await db.insert(users).values({ id: "u", handle: "owner", createdAt: NOW });
  await db.insert(characters).values({ id: "c", ownerId: "u", handle: "h", createdAt: NOW });
  await db.insert(characterVersions).values({
    id: "cv",
    characterId: "c",
    version: 1,
    name: "N",
    description: "D",
    createdAt: NOW,
  });
  await db.update(characters).set({ currentVersionId: "cv" }).where(eq(characters.id, "c"));
  await db.insert(chats).values({
    id: "ch",
    ownerId: "u",
    title: "T",
    characterVersionId: "cv",
    provider: "import",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

test("0007: nuking a chat cascades to messages, variants, session_entries, junctions", async () => {
  const db = await freshDb();
  await seedCharacterAndChat(db);
  await db
    .insert(messages)
    .values({ id: "m", chatId: "ch", seq: 0, role: "user", content: "hi", createdAt: NOW });
  await db
    .insert(messageVariants)
    .values({ id: "mv", messageId: "m", idx: 0, content: "v", createdAt: NOW });
  await db.insert(sessionEntries).values({
    id: "se",
    chatId: "ch",
    sessionId: "s",
    seq: 0,
    type: "user",
    entry: {},
    createdAt: NOW,
  });
  await db.insert(worldBooks).values({ id: "wb", ownerId: "u", name: "W", createdAt: NOW });
  await db.insert(worldEntries).values({ id: "we", worldBookId: "wb", title: "T", content: "C" });
  await db.insert(chatWorldEntries).values({ chatId: "ch", entryId: "we" });

  await db.delete(chats).where(eq(chats.id, "ch")); // the core YGWYG "nuke the chat"

  expect(await db.select().from(messages)).toHaveLength(0);
  expect(await db.select().from(messageVariants)).toHaveLength(0);
  expect(await db.select().from(sessionEntries)).toHaveLength(0);
  expect(await db.select().from(chatWorldEntries)).toHaveLength(0);
  // the world ENTRY survives — only the chat↔entry junction cascades (not the entry itself).
  expect(await db.select().from(worldEntries)).toHaveLength(1);
});

test("0007: deleting a character_version pinned by a chat is rejected (RESTRICT)", async () => {
  const db = await freshDb();
  await seedCharacterAndChat(db);

  await expect(
    db.delete(characterVersions).where(eq(characterVersions.id, "cv")),
  ).rejects.toThrow();
});

test("0007: deleting a character that has chats is blocked (CASCADE→versions hits chat RESTRICT)", async () => {
  const db = await freshDb();
  await seedCharacterAndChat(db);

  // Intended interaction: archive provenance-bearing entities, don't delete them.
  await expect(db.delete(characters).where(eq(characters.id, "c"))).rejects.toThrow();
  expect(await db.select().from(characters)).toHaveLength(1);
});

test("0007: deleting a preset_version pinned by a chat is rejected (RESTRICT)", async () => {
  const db = await freshDb();
  await seedCharacterAndChat(db);
  await db
    .insert(presets)
    .values({ id: "pr", ownerId: "u", name: "P", kind: "sampler", createdAt: NOW, updatedAt: NOW });
  await db
    .insert(presetVersions)
    .values({ id: "pv", presetId: "pr", version: 1, config: {}, createdAt: NOW });
  await db.update(chats).set({ presetVersionId: "pv" }).where(eq(chats.id, "ch"));

  await expect(db.delete(presetVersions).where(eq(presetVersions.id, "pv"))).rejects.toThrow();
});

test("0007: preset triad supports copy-on-write (circular currentVersionId; CASCADE on unpinned delete)", async () => {
  const db = await freshDb();
  await db.insert(users).values({ id: "u", handle: "owner", createdAt: NOW });
  // Circular insert order (mirrors the importer's character pattern): identity row with a
  // NULL currentVersionId → version → repoint.
  await db
    .insert(presets)
    .values({ id: "pr", ownerId: "u", name: "P", kind: "sampler", createdAt: NOW, updatedAt: NOW });
  await db
    .insert(presetVersions)
    .values({ id: "pv1", presetId: "pr", version: 1, config: { temp: 1 }, createdAt: NOW });
  await db.update(presets).set({ currentVersionId: "pv1" }).where(eq(presets.id, "pr"));
  // "Edit a pinned version" → fork v2, repoint (history preserved).
  await db
    .insert(presetVersions)
    .values({ id: "pv2", presetId: "pr", version: 2, config: { temp: 2 }, createdAt: NOW });
  await db.update(presets).set({ currentVersionId: "pv2" }).where(eq(presets.id, "pr"));

  expect(await db.select().from(presetVersions)).toHaveLength(2); // both versions retained

  // No chat/message pins these → deleting the preset cascades its versions.
  await db.delete(presets).where(eq(presets.id, "pr"));
  expect(await db.select().from(presetVersions)).toHaveLength(0);
});
