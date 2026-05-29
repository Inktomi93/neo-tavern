import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { userSettings } from "../../../db/schema";
import { parseUserSettings, type UserSettings } from "../../../shared/user-settings";

// Load + parse a user's settings blob into the typed contract. Lenient (never throws — a missing row
// or a legacy blob resolves to defaults). One loader shared by the settings service and the chat
// lifecycle (which seeds new-chat defaults from it), so neither couples to the other's service —
// mirrors `_shared/users.ts` / `_shared/audit.ts`.
export async function loadUserSettings(db: Db, ownerId: string): Promise<UserSettings> {
  const rows = await db
    .select({ config: userSettings.config })
    .from(userSettings)
    .where(eq(userSettings.userId, ownerId))
    .limit(1);
  return parseUserSettings(rows[0]?.config ?? {});
}
