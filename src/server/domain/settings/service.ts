import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { settings, userSettings } from "../../../db/schema";
import { parseUserSettings, USER_SETTINGS_SCHEMA_VERSION } from "../../../shared/user-settings";
import { logAudit } from "../_shared/audit";
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
      // First touch: persist an empty blob at the current schema version. parseUserSettings fills
      // every default on read, so the stored row stays minimal ({}) while callers get the full contract.
      const defaultSettings = {
        userId: ownerId,
        schemaVersion: USER_SETTINGS_SCHEMA_VERSION,
        config: {},
        updatedAt: Date.now(),
      };
      await db.insert(userSettings).values(defaultSettings);
      row = defaultSettings;
    }

    return {
      userId: row.userId,
      schemaVersion: row.schemaVersion,
      config: parseUserSettings(row.config),
      updatedAt: row.updatedAt,
    };
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

    await logAudit(db, "UPDATE_USER_SETTINGS", "settings", ownerId, { config: input.config });

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

    await logAudit(db, "SET_GLOBAL_SETTING", "settings", key, { value });

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
