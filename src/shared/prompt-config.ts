import { z } from "zod";
import { generationParamsSchema } from "./generation";

// The prompt structure a chat is generated under — the versioned `config` blob stored on
// `preset_versions.config` (migration 0007). It is ONE immutable snapshot per version
// (copy-on-write), which is why it lives as a blob, not normalized section rows: a message's
// `presetVersionId` must point at exactly the structure that produced it, and mutating a
// shared section row would silently rewrite past provenance. See docs/data-model.md.
//
// A prompt is an ORDERED list of sections (order = array index, the draggable order in the
// UI — no separate sectionOrder field to desync). At assembly time the sections before the
// single optional `boundary` become the STATIC (cache-stable) system prompt; everything after
// becomes the DYNAMIC suffix (re-evaluated per turn, cache-safe — see docs/sdk-notes.md).

export const PROMPT_ROLES = ["system", "user", "assistant"] as const;
export type PromptRole = (typeof PROMPT_ROLES)[number];

// Marker = a SLOT filled from the chat's data at assembly time (vs a literal text block).
// Character fields are SEPARATE markers (ST-style) so each is independently draggable, not
// lumped into one block. `char_system` = the card's own system-prompt override; `post_history`
// = post-history instructions (the "jailbreak", placed late). `chat_history` + `memory` matter
// for raw-mode (we own the array) / future retrieval; in sdk-mode history lives in the resumed
// session, so the default sdk config omits them. (Greetings — the `greetings[]` array
// — are NOT prompt sections; they seed the conversation, handled separately.)
export const MARKER_TYPES = [
  "char_description",
  "char_personality",
  "scenario",
  "dialogue_examples",
  "char_system",
  "post_history",
  "persona",
  "world_info",
  "chat_history",
  "memory",
  // The compaction summary (chats.compactSummary) — placed here, it lets the stateless openrouter
  // runner pick up from the compaction point (the summary stands in for the compacted-away turns).
  "compact_summary",
] as const;
export type MarkerType = (typeof MARKER_TYPES)[number];

// World Info entries carry a scope; a world_info marker renders only entries of ITS scope, so
// the `always` marker sits in the static half and the `keyword` marker in the dynamic half.
export const WORLD_INFO_SCOPES = ["always", "keyword"] as const;
export type WorldInfoScope = (typeof WORLD_INFO_SCOPES)[number];

// The macros a literal section's content can reference. Basic set; extend deliberately.
export const PROMPT_MACROS = ["char", "user", "persona", "scenario"] as const;
export type PromptMacro = (typeof PROMPT_MACROS)[number];

const literalSection = z.object({
  type: z.literal("literal"),
  id: z.string().min(1),
  name: z.string(),
  role: z.enum(PROMPT_ROLES).default("system"),
  content: z.string(), // may contain {{macros}}
  enabled: z.boolean().default(true),
});

const markerSection = z.object({
  type: z.literal("marker"),
  id: z.string().min(1),
  name: z.string(),
  marker: z.enum(MARKER_TYPES),
  role: z.enum(PROMPT_ROLES).default("system"),
  enabled: z.boolean().default(true),
  // world_info markers only: which scope of attached entries to render. Ignored otherwise.
  scope: z.enum(WORLD_INFO_SCOPES).optional(),
});

// The cache divider, as a typed section (advisor: a type tag, not a magic identifier string),
// so assembly splits on the type and exactly-one is enforced at parse time.
const boundarySection = z.object({
  type: z.literal("boundary"),
  id: z.string().min(1),
});

export const promptSectionSchema = z.discriminatedUnion("type", [
  literalSection,
  markerSection,
  boundarySection,
]);
export type PromptSection = z.infer<typeof promptSectionSchema>;

/** Current blob shape. Bump + add a lift below when the shape changes (NO DB migration needed). */
export const PROMPT_CONFIG_SCHEMA_VERSION = 1;

export const promptConfigSchema = z
  .object({
    schemaVersion: z.number().int().positive().default(PROMPT_CONFIG_SCHEMA_VERSION),
    sections: z.array(promptSectionSchema),
    // Generation knobs — the SINGLE provider-agnostic vocabulary (shared/generation.ts). Each runner
    // translates it to its native surface; a knob a runner can't honor is a no-op there.
    params: generationParamsSchema.default({}),
  })
  .refine((c) => c.sections.filter((s) => s.type === "boundary").length <= 1, {
    message: "a prompt config may have at most one boundary section",
  });
export type PromptConfig = z.infer<typeof promptConfigSchema>;

// Lift chain: maps a blob at version N to N+1. Empty today (v1 is current); when the shape
// changes, add `1: (c) => ({ ...c, schemaVersion: 2, <new field>: <default> })`. This is what
// makes `schemaVersion` real rather than decorative — `parsePromptConfig` walks it on load.
const CONFIG_LIFTS: Record<number, (config: Record<string, unknown>) => Record<string, unknown>> =
  {};

/** Parse a stored config blob, lifting older shapes to the current version first. */
export function parsePromptConfig(raw: unknown): PromptConfig {
  const probe = z.object({ schemaVersion: z.number().int().optional() }).safeParse(raw);
  let version = probe.success ? (probe.data.schemaVersion ?? 1) : 1;
  let config = raw;
  let lift = CONFIG_LIFTS[version];
  while (lift !== undefined && config !== null && typeof config === "object") {
    config = lift(config as Record<string, unknown>);
    version += 1;
    lift = CONFIG_LIFTS[version];
  }
  return promptConfigSchema.parse(config);
}

// The starter arrangement (used when a chat pins no preset). Static half: main instruction +
// character + persona + always-WI (all cache-stable). Dynamic half (after the boundary):
// keyword-WI, which varies per turn and so must not bust the cached prefix.
export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  schemaVersion: PROMPT_CONFIG_SCHEMA_VERSION,
  sections: [
    // The card's own system-prompt override (an addition/override to the main prompt). Present
    // in the manager but OFF by default — rarely authored (~14% of cards) and rarely wanted.
    {
      type: "marker",
      id: "char-system",
      name: "Character system",
      marker: "char_system",
      role: "system",
      enabled: false,
    },
    {
      type: "literal",
      id: "main",
      name: "Main",
      role: "system",
      content:
        "You are {{char}} in an immersive, ongoing roleplay with {{user}}. Stay in character; write {{char}}'s perspective only.",
      enabled: true,
    },
    {
      type: "marker",
      id: "char-desc",
      name: "Description",
      marker: "char_description",
      role: "system",
      enabled: true,
    },
    {
      type: "marker",
      id: "char-pers",
      name: "Personality",
      marker: "char_personality",
      role: "system",
      enabled: true,
    },
    {
      type: "marker",
      id: "scenario",
      name: "Scenario",
      marker: "scenario",
      role: "system",
      enabled: true,
    },
    {
      type: "marker",
      id: "persona",
      name: "Persona",
      marker: "persona",
      role: "system",
      enabled: true,
    },
    {
      type: "marker",
      id: "examples",
      name: "Dialogue examples",
      marker: "dialogue_examples",
      role: "system",
      enabled: true,
    },
    {
      type: "marker",
      id: "wi-always",
      name: "World Info (always)",
      marker: "world_info",
      role: "system",
      enabled: true,
      scope: "always",
    },
    // Everything below the boundary is re-evaluated per turn (cache-safe).
    { type: "boundary", id: "boundary" },
    {
      type: "marker",
      id: "wi-keyword",
      name: "World Info (keyword)",
      marker: "world_info",
      role: "system",
      enabled: true,
      scope: "keyword",
    },
    // Post-history instructions ("jailbreak") — last, so it'd be the final system steer. Present
    // in the manager but OFF by default (~17% of cards author it; rarely wanted here).
    {
      type: "marker",
      id: "post-history",
      name: "Post-history",
      marker: "post_history",
      role: "system",
      enabled: false,
    },
  ],
  params: {},
};
