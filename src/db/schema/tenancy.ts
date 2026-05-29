import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ───────────────────────── Tenancy ─────────────────────────
// DESIGNED multi-user, IMPLEMENTED single-user (one row). Identity =
// X-Authentik-Username, resolved at the auth seam (trusted-proxy header → that user;
// else DEFAULT_USER_HANDLE). Owned tables carry `ownerId`; scoping is enforced in the
// domain layer. assets/embeddings are global (see below).
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull().unique(), // = X-Authentik-Username
  displayName: text("display_name"),
  createdAt: integer("created_at").notNull(),
});

// Per-user config — ONE versioned blob (schemaVersion + migrate-fns), not ST's monolith.
export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  schemaVersion: integer("schema_version").notNull(),
  config: text("config", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});
