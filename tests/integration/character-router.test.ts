import { TRPCError } from "@trpc/server";
import { describe, expect, test } from "vitest";
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

async function createTestCaller(username: string) {
  const db = await freshDb();

  // Need to seed the user manually to satisfy FKs for services that assume the user exists,
  // or rely on ensureUser(). The character router does ensureUser() inside the domain service.

  const services = {
    character: createCharacterService(db),
    persona: createPersonaService(db),
    chat: createChatService(db),
    preset: createPresetService(db),
    corpus: createCorpusService(db),
    models: createModelsService(),
    search: createSearchService(db),
    settings: createSettingsService(db),
    worldInfo: createWorldInfoService(db),
    tag: createTagService(db),
  };

  const ctx = createContext({ username, services });
  return { caller: appRouter.createCaller(ctx), db };
}

describe("characterRouter", () => {
  test("create validates input and calls domain service", async () => {
    const { caller } = await createTestCaller("owner");

    // Fails zod validation (name too long, max 200)
    await expect(
      caller.character.create({
        handle: "char-1",
        name: "a".repeat(201),
        description: "Desc",
      }),
    ).rejects.toThrow(/too_big/i);

    // Success
    const c = await caller.character.create({
      handle: "char-1",
      name: "Valid Name",
      description: "Valid Desc",
    });

    expect(c.handle).toBe("char-1");
    expect(c.name).toBe("Valid Name");
    expect(c.description).toBe("Valid Desc");
    expect(c.version).toBe(1);
  });

  test("get throws NOT_FOUND for missing character", async () => {
    const { caller } = await createTestCaller("owner");

    await expect(caller.character.get({ characterId: "bogus" })).rejects.toThrow(TRPCError);

    try {
      await caller.character.get({ characterId: "bogus" });
    } catch (e) {
      expect(e instanceof TRPCError).toBe(true);
      expect((e as TRPCError).code).toBe("NOT_FOUND");
    }
  });

  test("update validates input and edits character", async () => {
    const { caller } = await createTestCaller("owner");

    const c = await caller.character.create({
      handle: "char-1",
      name: "Valid Name",
      description: "Valid Desc",
    });

    // Fails zod validation (starred is boolean)
    await expect(
      caller.character.update({
        characterId: c.id,
        // @ts-expect-error Intentionally passing invalid type
        starred: "not-a-boolean",
      }),
    ).rejects.toThrow();

    const updated = await caller.character.update({
      characterId: c.id,
      name: "New Name",
      description: "New Desc",
    });

    expect(updated.name).toBe("New Name");
  });

  test("list returns user characters", async () => {
    const { caller } = await createTestCaller("owner");

    await caller.character.create({ handle: "c1", name: "C1", description: "1" });
    await caller.character.create({ handle: "c2", name: "C2", description: "2" });

    const list = await caller.character.list();
    expect(list).toHaveLength(2);
    // Ordered by desc(createdAt)
    expect(list[0]?.handle).toBe("c2");
    expect(list[1]?.handle).toBe("c1");
  });
});
