import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db, runMigrations } from "../../../db/client";
import { createSettingsService } from "./service";

let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
  await runMigrations(db);
});

describe("settings service — user settings", () => {
  test("getUserSettings on a fresh user returns the parsed, defaulted contract (and creates the row)", async () => {
    const svc = createSettingsService(db);
    const view = await svc.getUserSettings({ username: "owner" });
    expect(view.schemaVersion).toBe(1);
    expect(view.config.regexScripts).toEqual([]);
    expect(view.config.defaultPresetId).toBeUndefined();
    // Second call hits the now-existing row and is stable.
    const again = await svc.getUserSettings({ username: "owner" });
    expect(again.config).toEqual(view.config);
  });

  test("updateUserSettings persists and round-trips through the parser", async () => {
    const svc = createSettingsService(db);
    await svc.getUserSettings({ username: "owner" }); // ensure row
    await svc.updateUserSettings(
      { username: "owner" },
      {
        config: {
          defaultPresetId: "preset-1",
          defaultApi: "chat-completions",
          defaultSource: "openrouter",
          regexScripts: [],
        },
      },
    );
    const view = await svc.getUserSettings({ username: "owner" });
    expect(view.config.defaultPresetId).toBe("preset-1");
    expect(view.config.defaultApi).toBe("chat-completions");
    expect(view.config.defaultSource).toBe("openrouter");
  });

  test("a previously-stored corrupt field is healed on read, not surfaced", async () => {
    const svc = createSettingsService(db);
    await svc.getUserSettings({ username: "owner" });
    // Simulate a legacy/garbage write landing in the blob (bypassing the typed write path).
    await svc.updateUserSettings(
      { username: "owner" },
      { config: { defaultPresetId: "good", defaultApi: "bogus" as never, regexScripts: [] } },
    );
    const view = await svc.getUserSettings({ username: "owner" });
    expect(view.config.defaultPresetId).toBe("good");
    expect(view.config.defaultApi).toBeUndefined(); // .catch healed the bad enum
  });
});
