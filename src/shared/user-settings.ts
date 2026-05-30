import { z } from "zod";
import { chatApiSchema, chatSourceSchema } from "./chat-routing";
import { generationParamsSchema } from "./generation";
import { isPlainObject } from "./guards";
import { regexScriptSchema } from "./regex";

// The typed per-user settings contract — the schema `user_settings.config` was always missing. Same
// shape as the preset config (`shared/prompt-config.ts`): a versioned blob with a lenient parser, so
// the DB row is canonical and the frontend gets a real contract instead of ST's schemaless
// `settings.json`. Every field is OPTIONAL — these are *defaults* a new chat seeds from (the seed
// chain is `arg ?? userDefault ?? schemaDefault`), so an unset field simply means "no preference,
// fall back". Per-field `.catch` makes the parser self-healing: one corrupt field resets to its
// default instead of nuking the whole blob (matters for forward/backward-compat as the shape grows).

export const USER_SETTINGS_SCHEMA_VERSION = 1;

export const userSettingsSchema = z.object({
  // New chats seed these when the caller doesn't specify (see domain/chat startChat). null/undefined
  // both mean "no default"; a stale id (deleted preset/persona) is tolerated at *consumption* time
  // (it degrades to the system default rather than failing chat creation) — not validated here.
  /** Preset IDENTITY (resolved to its `currentVersionId` at seed time), not a version id. */
  defaultPresetId: z.string().nullable().optional().catch(undefined),
  /** ST's `power_user.default_persona` — the global persona fallback tier. */
  defaultPersonaId: z.string().nullable().optional().catch(undefined),
  // The 4-mode routing tuple a new chat opens in. NOTE: `max-pro-sub` is the owner's single shared
  // credential — the seed seam guards against defaulting a non-owner into it (see startChat).
  defaultApi: chatApiSchema.optional().catch(undefined),
  defaultSource: chatSourceSchema.optional().catch(undefined),
  defaultModel: z.string().nullable().optional().catch(undefined),
  // STORED, NOT CONSUMED: your default preset's `params` ARE your default samplers (a preset is the
  // home for generation knobs, copy-on-write/immutable per turn). Kept so the frontend has the field
  // and a future per-chat override has a source; wiring it via resolveConfig would be a live
  // retroactive override that breaks preset immutability + hits the send hot path. See settings-audit.
  defaultGeneration: generationParamsSchema.optional().catch(undefined),
  // Profile bits NOT already on the `users` table. `displayName` stays a `users` column (single
  // source of truth); only genuinely-new bits live here.
  profile: z
    .object({ avatarAssetId: z.string().nullable().optional() })
    .optional()
    .catch(undefined),
  // Per-user regex scripts (find/replace over prompt + display). Subsumed from the old dead
  // `shared/schemas/settings.ts` (which had zero importers) — this is now their only home.
  regexScripts: z.array(regexScriptSchema).catch([]).default([]),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

/** The fully-defaulted settings object (what a brand-new / empty user resolves to). */
export const DEFAULT_USER_SETTINGS: UserSettings = userSettingsSchema.parse({});

// Lift chain: maps a stored blob at version N to N+1. Empty today (v1 is current); when the shape
// changes incompatibly, add `1: (c) => ({ ...c, schemaVersion: 2, … })`. Mirrors prompt-config.
const SETTINGS_LIFTS: Record<number, (config: Record<string, unknown>) => Record<string, unknown>> =
  {};

/**
 * Parse a stored `user_settings.config` blob into the typed contract, lifting older shapes first.
 * Lenient by construction: a non-object, a legacy `{}`, or a partially-corrupt blob never throws —
 * unknown keys are dropped, bad fields self-heal to their defaults (per-field `.catch`), and a total
 * failure falls back to `DEFAULT_USER_SETTINGS`. So existing rows keep working with no migration.
 */
export function parseUserSettings(raw: unknown): UserSettings {
  if (!isPlainObject(raw)) {
    return DEFAULT_USER_SETTINGS;
  }
  const probe = z.object({ schemaVersion: z.number().int().optional() }).safeParse(raw);
  let version = probe.success ? (probe.data.schemaVersion ?? 1) : 1;
  let config: Record<string, unknown> = raw;
  let lift = SETTINGS_LIFTS[version];
  while (lift !== undefined) {
    config = lift(config);
    version += 1;
    lift = SETTINGS_LIFTS[version];
  }
  const parsed = userSettingsSchema.safeParse(config);
  return parsed.success ? parsed.data : DEFAULT_USER_SETTINGS;
}
