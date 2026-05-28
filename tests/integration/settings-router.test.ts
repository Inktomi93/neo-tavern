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

  const otherCtx = createContext({ username: "other", services });
  const otherCaller = appRouter.createCaller(otherCtx);

  return { caller, otherCaller, db };
}

test("user settings CRUD", async () => {
  const { caller, otherCaller } = await setup();

  // Get defaults
  const settings = await caller.settings.getUserSettings();
  expect(settings.schemaVersion).toBe(1);
  expect(settings.config).toEqual({});

  // Update
  const updated = await caller.settings.updateUserSettings({
    config: { theme: "dark" },
  });
  expect(updated.config).toEqual({ theme: "dark" });

  // Isolation
  const otherSettings = await otherCaller.settings.getUserSettings();
  expect(otherSettings.config).toEqual({});
});

test("global settings CRUD", async () => {
  const { caller } = await setup();

  // Get missing
  const missing = await caller.settings.getGlobalSetting({ key: "not_found" });
  expect(missing).toBeNull();

  // Set
  const setting = await caller.settings.setGlobalSetting({
    key: "app_theme",
    value: "light",
  });
  expect(setting.value).toBe("light");

  // Get existing
  const existing = await caller.settings.getGlobalSetting({ key: "app_theme" });
  expect(existing?.value).toBe("light");

  // Update
  const updated = await caller.settings.setGlobalSetting({
    key: "app_theme",
    value: "dark",
  });
  expect(updated.value).toBe("dark");
});
