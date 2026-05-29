import type { AppSettings } from "../../../shared/app-settings";
import type { UserSettings } from "../../../shared/user-settings";
import type { EffectiveAppConfig } from "../../config/app-config";

export interface UserSettingsView {
  userId: string;
  schemaVersion: number;
  /** Parsed + defaulted (via `parseUserSettings`) — callers get the typed contract, not a raw blob. */
  config: UserSettings;
  updatedAt: number;
}

export interface UpdateUserSettingsInput {
  /** Validated against `userSettingsSchema` at the router/service boundary (full-replace semantics). */
  config: UserSettings;
  schemaVersion?: number | undefined;
}

export interface GlobalSettingView {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface SettingsService {
  getUserSettings(params: { username: string }): Promise<UserSettingsView>;
  updateUserSettings(
    params: { username: string },
    input: UpdateUserSettingsInput,
  ): Promise<UserSettingsView>;

  getGlobalSetting(key: string): Promise<GlobalSettingView | null>;
  setGlobalSetting(key: string, value: unknown): Promise<GlobalSettingView>;

  /** Admin-only. The resolved runtime config (env floor + stored override). */
  getAppSettings(params: { username: string }): Promise<EffectiveAppConfig>;
  /** Admin-only. Merge a partial override into the stored blob; returns the new resolved config. */
  updateAppSettings(
    params: { username: string },
    partial: AppSettings,
  ): Promise<EffectiveAppConfig>;
}
