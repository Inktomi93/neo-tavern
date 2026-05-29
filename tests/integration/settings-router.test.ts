import { expect } from "vitest";
import { test } from "../support/fixtures";

test("user settings CRUD", async ({ ownerCaller, otherCaller }) => {
  // Get defaults — now the parsed, typed contract (regexScripts defaulted, the rest unset).
  const settings = await ownerCaller.settings.getUserSettings();
  expect(settings.schemaVersion).toBe(1);
  expect(settings.config.regexScripts).toEqual([]);
  expect(settings.config.defaultPresetId).toBeUndefined();

  // Update with real, typed fields (an unknown key like the old `theme` is no longer accepted).
  const updated = await ownerCaller.settings.updateUserSettings({
    config: { defaultPresetId: "preset-1", defaultSource: "openrouter", regexScripts: [] },
  });
  expect(updated.config.defaultPresetId).toBe("preset-1");
  expect(updated.config.defaultSource).toBe("openrouter");

  // Isolation — a different user still resolves to defaults.
  const otherSettings = await otherCaller.settings.getUserSettings();
  expect(otherSettings.config.defaultPresetId).toBeUndefined();
});

test("global settings CRUD", async ({ ownerCaller }) => {
  // Get missing
  const missing = await ownerCaller.settings.getGlobalSetting({ key: "not_found" });
  expect(missing).toBeNull();

  // Set
  const setting = await ownerCaller.settings.setGlobalSetting({
    key: "app_theme",
    value: "light",
  });
  expect(setting.value).toBe("light");

  // Get existing
  const existing = await ownerCaller.settings.getGlobalSetting({ key: "app_theme" });
  expect(existing?.value).toBe("light");

  // Update
  const updated = await ownerCaller.settings.setGlobalSetting({
    key: "app_theme",
    value: "dark",
  });
  expect(updated.value).toBe("dark");
});
