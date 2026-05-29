import {
  type AnySQLiteColumn,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./tenancy";

// ───────────────────────── Config, assets, search, tags ─────────────────────────
// Presets use the identity / content-version / pin triad (copy-on-write, like characters):
// editing a version no chat/message pins mutates in place; editing a pinned version forks a
// new row. This is what keeps `messages.presetVersionId` an IMMUTABLE provenance record (a
// mutable preset would silently rewrite the recorded basis of every past message). The
// identity row holds NO config — `config` + `schemaVersion` live on preset_versions.
export const presets = sqliteTable("presets", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // descriptive library label (free text), NOT a structural type
  // Circular: the active version (which back-references this preset). SET NULL (bare pointer).
  currentVersionId: text("current_version_id").references(
    (): AnySQLiteColumn => presetVersions.id,
    { onDelete: "set null" },
  ),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Immutable content versions of a preset. config = the whole sampling/scaffold bundle;
// schemaVersion = the type-2 blob-shape version (kept for migrate-fns on the config blob).
export const presetVersions = sqliteTable(
  "preset_versions",
  {
    id: text("id").primaryKey(),
    presetId: text("preset_id")
      .notNull()
      .references(() => presets.id, { onDelete: "cascade" }), // versions die with the preset
    version: integer("version").notNull(),
    config: text("config", { mode: "json" }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("preset_versions_preset_ver_unq").on(t.presetId, t.version)],
);

// App-global key/value (one-time flags etc.). Per-user prefs live in user_settings.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Global + content-addressed — NO ownerId (binaries dedup by hash). The blob lives on the
// mounted volume in a sharded CAS tree keyed by `hash` (src/server/storage/cas.ts); the row is
// metadata only. There is NO `path` column — the locator IS the hash (cas.blobPath(hash)), so a
// moved/re-rooted volume needs no DB rewrite. Bytes NEVER go in the DB. GC is mark-sweep over the
// avatar refs below (no refcount column — refcounts drift). See docs/data-model.md / docs/assets.md.
