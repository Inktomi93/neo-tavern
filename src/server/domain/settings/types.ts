export interface UserSettingsView {
  userId: string;
  schemaVersion: number;
  config: unknown;
  updatedAt: number;
}

export interface UpdateUserSettingsInput {
  config: unknown;
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
}
