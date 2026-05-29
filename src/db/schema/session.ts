import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chats } from "./chats";

// ───────────────────────── SDK session persistence (the DbSessionStore substrate) ─────────────────────────
// The raw SDK transcript, stored opaquely for `resume`. SEPARATE from `messages` (our
// clean canon). sdk-mode only; regenerable-ish from messages.
export const sessionEntries = sqliteTable(
  "session_entries",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }), // resume cache dies with the chat
    sessionId: text("session_id").notNull(), // SDK session id (== chats.session_id)
    subpath: text("subpath"), // SessionKey.subpath (subagents); "" = main transcript (NOT null — null defeats the uuid unique-index dedup; see store.ts)
    seq: integer("seq").notNull(), // append order
    uuid: text("uuid"), // SDK entry uuid — idempotency key (nullable: titles/tags have none)
    type: text("type").notNull(),
    entry: text("entry", { mode: "json" }).notNull(), // the raw frame, opaque
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("session_entries_load_idx").on(t.sessionId, t.subpath, t.seq),
    // backs append()'s upsert/dedup (SDK replays uuids on retry / importSessionToStore)
    uniqueIndex("session_entries_uuid_unq")
      .on(t.sessionId, t.subpath, t.uuid)
      .where(sql`${t.uuid} is not null`),
  ],
);
