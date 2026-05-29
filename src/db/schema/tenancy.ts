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
  // Access role. The DESIGNED-multi-user hook (gates admin surfaces like AppSettings). Default
  // "user" is deliberate: ensureUser JIT-provisions a row per authentik username, so an "admin"
  // default would auto-admin every future user (escalation-by-default). The owner becomes admin via
  // ensureUser (role="admin" iff handle === DEFAULT_USER_HANDLE) + a one-time migration backfill.
  role: text("role", { enum: ["admin", "user"] })
    .notNull()
    .default("user"),
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
