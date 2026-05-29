import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { settings } from "../../db/schema";
import { type AppSettings, type LogLevel, parseAppSettings } from "../../shared/app-settings";
import { env } from "../env";

// The effective runtime config = a stored admin override (the `settings` KV under key "app") layered
// over the env-derived defaults. env stays the FLOOR — an unset override field falls through to it.
// Readers call the sync `getAppConfig()`; an async `reloadAppConfig(db)` (at boot + after every admin
// write) refreshes the in-memory cache, so the hot paths (send/embedder) never do a per-call DB read.
//
// SINGLE-PROCESS ASSUMPTION: the cache is in-process; an admin write busts only this process's copy.
// True per the deploy invariant (one image, port 8788). If the app is ever scaled to multiple
// processes, this needs cross-process invalidation — a known boundary, not a latent bug.

export const APP_SETTINGS_KEY = "app";

/** The fully-resolved runtime config (every field present). */
export interface EffectiveAppConfig {
  corpusAutoindex: boolean;
  importSkipCharacters: string[];
  logLevel: LogLevel;
  idleUnloadMin: number;
}

// env's raw shapes (a "true"/"false" string, a comma list) normalized into the typed defaults.
function envDefaults(): EffectiveAppConfig {
  return {
    corpusAutoindex: env.CORPUS_AUTOINDEX === "true",
    importSkipCharacters: env.IMPORT_SKIP_CHARACTERS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL,
    idleUnloadMin: env.IDLE_UNLOAD_MIN,
  };
}

function layer(overrides: AppSettings): EffectiveAppConfig {
  const base = envDefaults();
  return {
    corpusAutoindex: overrides.corpusAutoindex ?? base.corpusAutoindex,
    importSkipCharacters: overrides.importSkipCharacters ?? base.importSkipCharacters,
    logLevel: overrides.logLevel ?? base.logLevel,
    idleUnloadMin: overrides.idleUnloadMin ?? base.idleUnloadMin,
  };
}

let cache: EffectiveAppConfig | undefined;

/** The resolved runtime config. Before the first `reloadAppConfig`, this is env-only (the safe floor). */
export function getAppConfig(): EffectiveAppConfig {
  if (cache === undefined) {
    cache = layer({});
  }
  return cache;
}

/** Re-read the stored override blob and rebuild the cache. Call at boot and after every admin write. */
export async function reloadAppConfig(db: Db): Promise<EffectiveAppConfig> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, APP_SETTINGS_KEY))
    .limit(1);
  cache = layer(parseAppSettings(rows[0]?.value ?? {}));
  return cache;
}

/** Test-only: drop the in-memory cache so the next `getAppConfig()` re-derives from env. */
export function __resetAppConfigCache(): void {
  cache = undefined;
}
