import { expect, test } from "vitest";
import { createCharacterService } from "../../src/server/domain/character";
import { createChatService } from "../../src/server/domain/chat";
import { createCorpusService } from "../../src/server/domain/corpus";
import { createModelsService } from "../../src/server/domain/models";
import { createPersonaService } from "../../src/server/domain/persona";
import { createPresetService } from "../../src/server/domain/preset";
import { createSearchService } from "../../src/server/domain/search";
import { createSettingsService } from "../../src/server/domain/settings";
import { createTagService } from "../../src/server/domain/tag";
import { createWorldInfoService } from "../../src/server/domain/world-info";
import { createContext } from "../../src/server/trpc/context";
import { appRouter } from "../../src/server/trpc/router";
import { freshDb } from "../support/db";

async function setup() {
  const db = await freshDb();
  const services = {
    character: createCharacterService(db),
    chat: createChatService(db),
    corpus: createCorpusService(db),
    models: createModelsService(),
    persona: createPersonaService(db),
    preset: createPresetService(db),
    search: createSearchService(db),
    settings: createSettingsService(db),
    tag: createTagService(db),
    worldInfo: createWorldInfoService(db),
  };
  const ctx = createContext({ username: "owner", services });
  const caller = appRouter.createCaller(ctx);

  // also create another user to test isolation
  const otherCtx = createContext({ username: "other", services });
  const otherCaller = appRouter.createCaller(otherCtx);

  return { caller, otherCaller, db };
}

test("world info books CRUD", async () => {
  const { caller, otherCaller } = await setup();

  // Create book
  const { id: bookId } = await caller.worldInfo.createBook({
    name: "My Fantasy World",
    description: "A cool place",
  });
  expect(bookId).toBeDefined();

  // List books
  const books = await caller.worldInfo.listBooks();
  expect(books).toHaveLength(1);
  expect(books[0]?.name).toBe("My Fantasy World");

  // Get book
  const book = await caller.worldInfo.getBook({ bookId });
  expect(book.name).toBe("My Fantasy World");

  // Update book
  await caller.worldInfo.updateBook({ bookId, name: "Dark Fantasy World" });
  const updated = await caller.worldInfo.getBook({ bookId });
  expect(updated.name).toBe("Dark Fantasy World");

  // Isolation
  await expect(otherCaller.worldInfo.getBook({ bookId })).rejects.toThrow("book not found");

  // Delete book
  await caller.worldInfo.removeBook({ bookId });
  await expect(caller.worldInfo.getBook({ bookId })).rejects.toThrow("book not found");
  expect(await caller.worldInfo.listBooks()).toHaveLength(0);
});

test("world info entries CRUD", async () => {
  const { caller, otherCaller } = await setup();

  const { id: bookId } = await caller.worldInfo.createBook({
    name: "Lorebook",
  });

  // Create entry
  const { id: entryId } = await caller.worldInfo.createEntry({
    bookId,
    title: "Goblin",
    content: "Green and mean.",
    legacyKeys: ["goblin", "orc"],
    priority: 10,
  });

  // List entries
  const entries = await caller.worldInfo.listEntries({ bookId });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.title).toBe("Goblin");
  expect(entries[0]?.content).toBe("Green and mean.");

  // Get entry
  const entry = await caller.worldInfo.getEntry({ entryId });
  expect(entry.title).toBe("Goblin");

  // Update entry
  await caller.worldInfo.updateEntry({ entryId, title: "Hobgoblin" });
  const updated = await caller.worldInfo.getEntry({ entryId });
  expect(updated.title).toBe("Hobgoblin");

  // Isolation
  await expect(otherCaller.worldInfo.getEntry({ entryId })).rejects.toThrow("entry not found");

  // Delete entry
  await caller.worldInfo.removeEntry({ entryId });
  await expect(caller.worldInfo.getEntry({ entryId })).rejects.toThrow("entry not found");
  expect(await caller.worldInfo.listEntries({ bookId })).toHaveLength(0);
});
