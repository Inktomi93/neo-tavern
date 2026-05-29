import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { assets } from "./assets";
import { users } from "./tenancy";

// ───────────────────────── Characters (identity / content / instance) ─────────────────────────
export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  // FK added once assets were in use (skipped in 0007). SET NULL: a deleted/GC'd avatar
  // leaves the persona intact, just avatar-less.
  avatarAssetId: text("avatar_asset_id").references((): AnySQLiteColumn => assets.id, {
    onDelete: "set null",
  }),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
});

export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    handle: text("handle").notNull().unique(), // → unique(ownerId, handle) under multi-user
    // Circular: points at the active version (which back-references this character). SET NULL
    // (a bare pointer); the version itself is RESTRICT-protected while a chat pins it.
    currentVersionId: text("current_version_id").references(
      (): AnySQLiteColumn => characterVersions.id,
      { onDelete: "set null" },
    ),
    importedFrom: text("imported_from"),
    importHash: text("import_hash"),
    starred: integer("starred", { mode: "boolean" }).default(false),
    archived: integer("archived", { mode: "boolean" }).default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("characters_owner_idx").on(t.ownerId)],
);

// Immutable content versions (copy-on-write: a version freezes once a chat pins it).
export const characterVersions = sqliteTable(
  "character_versions",
  {
    id: text("id").primaryKey(),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }), // versions die with the character
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    personality: text("personality"),
    scenario: text("scenario"),
    // All greetings unified into ONE ordered array: [0] = the primary first message (ST's
    // first_mes), the rest = alternates. Folded from the old first_message + alt_greetings — they
    // ARE the same swipeable set in ST's opening-message UI. Empty array = no seeded opening.
    greetings: text("greetings", { mode: "json" }),
    exampleMessages: text("example_messages"),
    systemPrompt: text("system_prompt"),
    postHistoryInstructions: text("post_history_instructions"),
    tags: text("tags", { mode: "json" }),
    creatorNotes: text("creator_notes"),
    // The card PNG is the avatar (one blob, both roles). FK added once assets were in use
    // (skipped in 0007). SET NULL: a GC'd/deleted asset leaves the version, just avatar-less.
    avatarAssetId: text("avatar_asset_id").references((): AnySQLiteColumn => assets.id, {
      onDelete: "set null",
    }),
    raw: text("raw", { mode: "json" }), // archival original card — never versioned/migrated
    refineryScore: real("refinery_score"),
    refineryAnalysis: text("refinery_analysis", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("character_versions_char_ver_unq").on(t.characterId, t.version)],
);
