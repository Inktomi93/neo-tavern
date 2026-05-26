import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { chats, personas } from "../../src/db/schema";
import { newId } from "../../src/server/domain/_shared/ids";
import { ensureUser } from "../../src/server/domain/_shared/users";
import { createChatService } from "../../src/server/domain/chat";
import { freshDb } from "../support/db";

// Insert a persona directly (no create API yet) and return its id.
async function makePersona(
  db: Awaited<ReturnType<typeof freshDb>>,
  ownerId: string,
  name: string,
  description: string,
): Promise<string> {
  const id = newId();
  await db.insert(personas).values({ id, ownerId, name, description, createdAt: Date.now() });
  return id;
}

test("the CARD's {{user}} resolves to the PINNED persona; the persona marker to the ACTIVE one", async () => {
  const db = await freshDb();
  const chat = createChatService(db);
  const ownerId = await ensureUser(db, "owner");

  // A card whose description references {{user}} — char_description renders against the PINNED persona.
  const { chatId } = await chat.create({
    username: "owner",
    title: "t",
    characterName: "Cae",
    characterDescription: "adores {{user}}",
  });

  const active = await makePersona(db, ownerId, "Alice", "the hero");
  const pinned = await makePersona(db, ownerId, "Bob", "the villain");
  await db
    .update(chats)
    .set({ personaId: active, pinnedPersonaId: pinned })
    .where(eq(chats.id, chatId));

  const preview = await chat.previewAssembly({ username: "owner", chatId });
  const staticHalf = preview.systemPrompt.static;

  expect(staticHalf).toContain("adores Bob"); // the CARD field used the PINNED persona
  expect(staticHalf).not.toContain("adores Alice"); // …NOT the active one
  expect(staticHalf).toContain("Alice: the hero"); // the persona marker used the ACTIVE persona
});

test("pinnedPersonaId null falls back to the active persona (legacy / no persona at open)", async () => {
  const db = await freshDb();
  const chat = createChatService(db);
  const ownerId = await ensureUser(db, "owner");

  const { chatId } = await chat.create({
    username: "owner",
    title: "t",
    characterName: "Cae",
    characterDescription: "adores {{user}}",
  });
  const active = await makePersona(db, ownerId, "Alice", "the hero");
  // only the active persona set; pinnedPersonaId stays null
  await db.update(chats).set({ personaId: active }).where(eq(chats.id, chatId));

  const preview = await chat.previewAssembly({ username: "owner", chatId });
  expect(preview.systemPrompt.static).toContain("adores Alice"); // fell back to active
});
