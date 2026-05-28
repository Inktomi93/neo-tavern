import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { auditLogs, settings, userSettings } from "../../../db/schema";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import type {
  GlobalSettingView,
  SettingsService,
  UpdateUserSettingsInput,
  UserSettingsView,
} from "./types";

export function createSettingsService(db: Db): SettingsService {
  async function getUserSettings(params: { username: string }): Promise<UserSettingsView> {
    const ownerId = await ensureUser(db, params.username);
    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, ownerId));
    let row = rows[0];

    if (!row) {
      // Create default settings if none exist
      const defaultSettings = {
        userId: ownerId,
        schemaVersion: 1,
        config: {},
        updatedAt: Date.now(),
      };
      await db.insert(userSettings).values(defaultSettings);
      row = defaultSettings;
    }

    return row;
  }

  async function updateUserSettings(
    params: { username: string },
    input: UpdateUserSettingsInput,
  ): Promise<UserSettingsView> {
    const ownerId = await ensureUser(db, params.username);

    // Ensure exists
    await getUserSettings(params);

    const updates: Partial<typeof userSettings.$inferInsert> = {
      config: input.config,
      updatedAt: Date.now(),
    };
    if (input.schemaVersion !== undefined) {
      updates.schemaVersion = input.schemaVersion;
    }

    await db.update(userSettings).set(updates).where(eq(userSettings.userId, ownerId));

    await db.insert(auditLogs).values({
      id: newId(),
      timestamp: Date.now(),
      action: "UPDATE_USER_SETTINGS",
      domain: "settings",
      entityId: ownerId,
      details: { config: input.config },
    });

    return getUserSettings(params);
  }

  async function getGlobalSetting(key: string): Promise<GlobalSettingView | null> {
    const rows = await db.select().from(settings).where(eq(settings.key, key));
    return rows[0] ?? null;
  }

  async function setGlobalSetting(key: string, value: unknown): Promise<GlobalSettingView> {
    const updatedAt = Date.now();
    await db.insert(settings).values({ key, value, updatedAt }).onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt },
    });

    await db.insert(auditLogs).values({
      id: newId(),
      timestamp: Date.now(),
      action: "SET_GLOBAL_SETTING",
      domain: "settings",
      entityId: key,
      details: { value },
    });

    const rows = await db.select().from(settings).where(eq(settings.key, key));
    // biome-ignore lint/style/noNonNullAssertion: guaranteed to exist
    return rows[0]!;
  }

  return {
    getUserSettings,
    updateUserSettings,
    getGlobalSetting,
    setGlobalSetting,
  };
}
