import { test as baseTest } from "vitest";
import type { Db } from "../../src/db/client";
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
import { freshDb } from "./db";

export interface AppServices {
  character: ReturnType<typeof createCharacterService>;
  chat: ReturnType<typeof createChatService>;
  corpus: ReturnType<typeof createCorpusService>;
  models: ReturnType<typeof createModelsService>;
  persona: ReturnType<typeof createPersonaService>;
  preset: ReturnType<typeof createPresetService>;
  search: ReturnType<typeof createSearchService>;
  settings: ReturnType<typeof createSettingsService>;
  tag: ReturnType<typeof createTagService>;
  worldInfo: ReturnType<typeof createWorldInfoService>;
}

export type IntegrationFixtures = {
  db: Db;
  services: AppServices;
  ownerCaller: ReturnType<typeof appRouter.createCaller>;
  otherCaller: ReturnType<typeof appRouter.createCaller>;
};

export const test = baseTest.extend<IntegrationFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Vitest fixture
  db: async ({}, use) => {
    const dbInstance = await freshDb();
    await use(dbInstance);
  },
  services: async ({ db }, use) => {
    const services: AppServices = {
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
    await use(services);
  },
  ownerCaller: async ({ services }, use) => {
    const ctx = createContext({ username: "owner", services });
    const ownerCaller = appRouter.createCaller(ctx);
    await use(ownerCaller);
  },
  otherCaller: async ({ services }, use) => {
    const ctx = createContext({ username: "other", services });
    const ownerCaller = appRouter.createCaller(ctx);
    await use(ownerCaller);
  },
});
