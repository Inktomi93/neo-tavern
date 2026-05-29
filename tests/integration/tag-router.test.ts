import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import { characterTags } from "../../src/db/schema";
import { test } from "../support/fixtures";

test("tags CRUD", async ({ ownerCaller, otherCaller }) => {
  // Create
  const tag = await ownerCaller.tag.create({
    name: "Fantasy",
    color: "#ff0000",
  });
  expect(tag.name).toBe("Fantasy");
  expect(tag.color).toBe("#ff0000");
  expect(tag.source).toBe("manual");

  // List
  const list = await ownerCaller.tag.list();
  expect(list).toHaveLength(1);
  expect(list[0]?.name).toBe("Fantasy");

  // Get
  const fetched = await ownerCaller.tag.get({ tagId: tag.id });
  expect(fetched.name).toBe("Fantasy");

  // Update
  const updated = await ownerCaller.tag.update({ tagId: tag.id, color: "#00ff00" });
  expect(updated.color).toBe("#00ff00");

  // Isolation
  await expect(otherCaller.tag.get({ tagId: tag.id })).rejects.toThrow("tag not found");

  // Delete
  await ownerCaller.tag.remove({ tagId: tag.id });
  await expect(ownerCaller.tag.get({ tagId: tag.id })).rejects.toThrow("tag not found");
  expect(await ownerCaller.tag.list()).toHaveLength(0);
});

test("tag attachment", async ({ ownerCaller, db }) => {
  const tag = await ownerCaller.tag.create({ name: "Fav" });

  // Just testing attachment logic exists. We don't need a real character
  // because there's no FK constraint enforced by SQLite in this specific
  // test environment if it's disabled, or we can just mock a character.
  // Wait, libsql with drizzle enforces FKs! So we should create a real character.

  const charId = await ownerCaller.character.create({
    handle: "test",
    name: "Test",
    description: "test",
  });

  await ownerCaller.tag.attach({
    tagId: tag.id,
    targetType: "character",
    targetId: charId.id,
  });

  let links = await db
    .select()
    .from(characterTags)
    .where(and(eq(characterTags.tagId, tag.id), eq(characterTags.characterId, charId.id)));
  expect(links).toHaveLength(1);

  await ownerCaller.tag.detach({
    tagId: tag.id,
    targetType: "character",
    targetId: charId.id,
  });

  links = await db
    .select()
    .from(characterTags)
    .where(and(eq(characterTags.tagId, tag.id), eq(characterTags.characterId, charId.id)));
  expect(links).toHaveLength(0);
});
