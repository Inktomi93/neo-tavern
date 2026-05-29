import { expect } from "vitest";
import { test } from "../support/fixtures";

test("user settings CRUD", async ({ ownerCaller, otherCaller }) => {
  // Get defaults
  const settings = await ownerCaller.settings.getUserSettings();
  expect(settings.schemaVersion).toBe(1);
  expect(settings.config).toEqual({});

  // Update
  const updated = await ownerCaller.settings.updateUserSettings({
    config: { theme: "dark" },
  });
  expect(updated.config).toEqual({ theme: "dark" });

  // Isolation
  const otherSettings = await otherCaller.settings.getUserSettings();
  expect(otherSettings.config).toEqual({});
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
