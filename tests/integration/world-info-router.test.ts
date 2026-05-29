import { expect } from "vitest";
import { test } from "../support/fixtures";

test("world info books CRUD", async ({ ownerCaller, otherCaller }) => {
  // Create book
  const { id: bookId } = await ownerCaller.worldInfo.createBook({
    name: "My Fantasy World",
    description: "A cool place",
  });
  expect(bookId).toBeDefined();

  // List books
  const books = await ownerCaller.worldInfo.listBooks();
  expect(books).toHaveLength(1);
  expect(books[0]?.name).toBe("My Fantasy World");

  // Get book
  const book = await ownerCaller.worldInfo.getBook({ bookId });
  expect(book.name).toBe("My Fantasy World");

  // Update book
  await ownerCaller.worldInfo.updateBook({ bookId, name: "Dark Fantasy World" });
  const updated = await ownerCaller.worldInfo.getBook({ bookId });
  expect(updated.name).toBe("Dark Fantasy World");

  // Isolation
  await expect(otherCaller.worldInfo.getBook({ bookId })).rejects.toThrow("book not found");

  // Delete book
  await ownerCaller.worldInfo.removeBook({ bookId });
  await expect(ownerCaller.worldInfo.getBook({ bookId })).rejects.toThrow("book not found");
  expect(await ownerCaller.worldInfo.listBooks()).toHaveLength(0);
});

test("world info entries CRUD", async ({ ownerCaller, otherCaller }) => {
  const { id: bookId } = await ownerCaller.worldInfo.createBook({
    name: "Lorebook",
  });

  // Create entry
  const { id: entryId } = await ownerCaller.worldInfo.createEntry({
    bookId,
    title: "Goblin",
    content: "Green and mean.",
    legacyKeys: ["goblin", "orc"],
    priority: 10,
  });

  // List entries
  const entries = await ownerCaller.worldInfo.listEntries({ bookId });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.title).toBe("Goblin");
  expect(entries[0]?.content).toBe("Green and mean.");

  // Get entry
  const entry = await ownerCaller.worldInfo.getEntry({ entryId });
  expect(entry.title).toBe("Goblin");

  // Update entry
  await ownerCaller.worldInfo.updateEntry({ entryId, title: "Hobgoblin" });
  const updated = await ownerCaller.worldInfo.getEntry({ entryId });
  expect(updated.title).toBe("Hobgoblin");

  // Isolation
  await expect(otherCaller.worldInfo.getEntry({ entryId })).rejects.toThrow("entry not found");

  // Delete entry
  await ownerCaller.worldInfo.removeEntry({ entryId });
  await expect(ownerCaller.worldInfo.getEntry({ entryId })).rejects.toThrow("entry not found");
  expect(await ownerCaller.worldInfo.listEntries({ bookId })).toHaveLength(0);
});
