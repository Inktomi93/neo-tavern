import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { characterTags } from "../../src/db/schema";
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

  const otherCtx = createContext({ username: "other", services });
  const otherCaller = appRouter.createCaller(otherCtx);

  return { caller, otherCaller, db };
}

test("tags CRUD", async () => {
  const { caller, otherCaller } = await setup();

  // Create
  const tag = await caller.tag.create({
    name: "Fantasy",
    color: "#ff0000",
  });
  expect(tag.name).toBe("Fantasy");
  expect(tag.color).toBe("#ff0000");
  expect(tag.source).toBe("manual");

  // List
  const list = await caller.tag.list();
  expect(list).toHaveLength(1);
  expect(list[0]?.name).toBe("Fantasy");

  // Get
  const fetched = await caller.tag.get({ tagId: tag.id });
  expect(fetched.name).toBe("Fantasy");

  // Update
  const updated = await caller.tag.update({ tagId: tag.id, color: "#00ff00" });
  expect(updated.color).toBe("#00ff00");

  // Isolation
  await expect(otherCaller.tag.get({ tagId: tag.id })).rejects.toThrow("tag not found");

  // Delete
  await caller.tag.remove({ tagId: tag.id });
  await expect(caller.tag.get({ tagId: tag.id })).rejects.toThrow("tag not found");
  expect(await caller.tag.list()).toHaveLength(0);
});

test("tag attachment", async () => {
  const { caller, db } = await setup();

  const tag = await caller.tag.create({ name: "Fav" });

  // Just testing attachment logic exists. We don't need a real character
  // because there's no FK constraint enforced by SQLite in this specific
  // test environment if it's disabled, or we can just mock a character.
  // Wait, libsql with drizzle enforces FKs! So we should create a real character.

  const charId = await caller.character.create({
    handle: "test",
    name: "Test",
    description: "test",
  });

  await caller.tag.attach({
    tagId: tag.id,
    targetType: "character",
    targetId: charId.id,
  });

  let links = await db
    .select()
    .from(characterTags)
    .where(and(eq(characterTags.tagId, tag.id), eq(characterTags.characterId, charId.id)));
  expect(links).toHaveLength(1);

  await caller.tag.detach({
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
