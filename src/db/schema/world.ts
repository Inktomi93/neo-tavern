import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { characterVersions } from "./characters";
import { chats } from "./chats";
import { users } from "./tenancy";

// ───────────────────────── World info (explicit attachment, never keyword-scanned) ─────────────────────────
export const worldBooks = sqliteTable("world_books", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("created_at").notNull(),
});

export const worldEntries = sqliteTable(
  "world_entries",
  {
    id: text("id").primaryKey(),
    worldBookId: text("world_book_id")
      .notNull()
      .references(() => worldBooks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    legacyKeys: text("legacy_keys", { mode: "json" }), // ST keyword triggers — import compat only, never scanned
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    priority: integer("priority").default(0),
    metadata: text("metadata", { mode: "json" }),
  },
  (t) => [index("world_entries_book_idx").on(t.worldBookId)],
);

export const chatWorldEntries = sqliteTable(
  "chat_world_entries",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => worldEntries.id, { onDelete: "cascade" }),
    scope: text("scope").default("always"),
    pinned: integer("pinned", { mode: "boolean" }).default(true),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.entryId] }),
    index("chat_world_entries_entry_idx").on(t.entryId),
  ],
);

export const characterVersionWorldEntries = sqliteTable(
  "cv_world_entries",
  {
    characterVersionId: text("cv_id")
      .notNull()
      .references(() => characterVersions.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => worldEntries.id, { onDelete: "cascade" }),
    scope: text("scope").default("always"),
  },
  (t) => [
    primaryKey({ columns: [t.characterVersionId, t.entryId] }),
    index("cv_world_entries_entry_idx").on(t.entryId),
  ],
);
