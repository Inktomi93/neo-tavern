import { z } from "zod";

// The DB-backed, admin-editable runtime-config OVERRIDE contract. Only the handful of `env.ts` knobs
// that are genuine runtime operational toggles (non-secret, non-bootstrap, non-GPU-box) live here —
// the rest stay env (see docs/settings-audit.md "server-config triage" for the boundary). Every field
// is OPTIONAL: absence means "no override → use the env default" (env is the floor). The server-side
// resolver (server/config/app-config.ts) layers a stored override over env-derived defaults; this
// shared module is platform-agnostic and deliberately does NOT import env.

// Mirrors env.ts's LOG_LEVEL enum (kept in sync by hand — both small + rarely changed).
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const APP_SETTINGS_SCHEMA_VERSION = 1;

export const appSettingsSchema = z.object({
  /** Background corpus auto-indexing on/off (read per-turn). */
  corpusAutoindex: z.boolean().optional().catch(undefined),
  /** Character names (case-insensitive) excluded at ST import — card + its chats dropped. */
  importSkipCharacters: z.array(z.string()).optional().catch(undefined),
  /** Log verbosity. Live change affects per-call readers; boot-time logger init keeps the env value
   *  until restart (documented). */
  logLevel: z.enum(LOG_LEVELS).optional().catch(undefined),
  /** Minutes of model idle before VRAM unload. Takes effect on the next warm-model (re)construction. */
  idleUnloadMin: z.number().min(0).optional().catch(undefined),
});

/** The stored OVERRIDE blob — every field optional (a missing field = use the env default). */
export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * Parse a stored app-settings override blob. Lenient by construction (per-field `.catch`, non-object
 * → `{}` = no overrides) — never throws, so a legacy/garbage blob degrades to "use all env defaults".
 */
export function parseAppSettings(raw: unknown): AppSettings {
  if (raw === null || typeof raw !== "object") {
    return {};
  }
  const parsed = appSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
