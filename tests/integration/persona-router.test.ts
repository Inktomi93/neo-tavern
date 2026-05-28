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

describe("personaRouter", () => {
  test("create validates input and calls domain service", async () => {
    const { caller } = await createTestCaller("owner");

    // Fails zod validation (name too long)
    await expect(
      caller.persona.create({
        name: "a".repeat(201),
        description: "Desc",
      }),
    ).rejects.toThrow(/too_big/i);

    // Success
    const p = await caller.persona.create({
      name: "Valid Name",
      description: "Valid Desc",
    });

    expect(p.name).toBe("Valid Name");
    expect(p.description).toBe("Valid Desc");
  });

  test("get throws NOT_FOUND for missing persona", async () => {
    const { caller } = await createTestCaller("owner");

    try {
      await caller.persona.get({ personaId: "bogus" });
    } catch (e) {
      expect(e instanceof TRPCError).toBe(true);
      expect((e as TRPCError).code).toBe("NOT_FOUND");
    }
  });

  test("update validates input and edits persona", async () => {
    const { caller } = await createTestCaller("owner");

    const p = await caller.persona.create({
      name: "Valid Name",
      description: "Valid Desc",
    });

    const updated = await caller.persona.update({
      personaId: p.id,
      name: "New Name",
    });

    expect(updated.name).toBe("New Name");
    expect(updated.description).toBe("Valid Desc");
  });

  test("list returns user personas", async () => {
    const { caller } = await createTestCaller("owner");

    await caller.persona.create({ name: "P1", description: "1" });
    await new Promise((r) => setTimeout(r, 5));
    await caller.persona.create({ name: "P2", description: "2" });

    const list = await caller.persona.list();
    expect(list).toHaveLength(2);
    // Ordered by desc(createdAt)
    expect(list[0]?.name).toBe("P2");
    expect(list[1]?.name).toBe("P1");
  });

  test("remove deletes persona", async () => {
    const { caller } = await createTestCaller("owner");

    const p = await caller.persona.create({
      name: "Valid Name",
      description: "Valid Desc",
    });

    const res = await caller.persona.remove({ personaId: p.id });
    expect(res.deleted).toBe(true);

    await expect(caller.persona.get({ personaId: p.id })).rejects.toThrow();
  });
});
