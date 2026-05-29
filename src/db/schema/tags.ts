import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { characters, personas } from "./characters";
import { chats } from "./chats";
import { presets } from "./config";
import { users } from "./tenancy";
import { worldBooks } from "./world";

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull().unique(), // → unique(ownerId, name) under multi-user
  color: text("color"),
  source: text("source", { enum: ["manual", "auto"] }).default("manual"),
});

export const characterTags = sqliteTable(
  "character_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tagId, t.characterId] }),
    index("character_tags_char_idx").on(t.characterId),
  ],
);

export const chatTags = sqliteTable(
  "chat_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.tagId, t.chatId] }), index("chat_tags_chat_idx").on(t.chatId)],
);

export const worldBookTags = sqliteTable(
  "world_book_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    worldBookId: text("world_book_id")
      .notNull()
      .references(() => worldBooks.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tagId, t.worldBookId] }),
    index("world_book_tags_book_idx").on(t.worldBookId),
  ],
);

export const personaTags = sqliteTable(
  "persona_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tagId, t.personaId] }),
    index("persona_tags_persona_idx").on(t.personaId),
  ],
);

export const presetTags = sqliteTable(
  "preset_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    presetId: text("preset_id")
      .notNull()
      .references(() => presets.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tagId, t.presetId] }),
    index("preset_tags_preset_idx").on(t.presetId),
  ],
);
