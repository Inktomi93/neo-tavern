// Read-only DB introspection for the /api/_debug surface — "did this actually land in the DB?"
// without opening the SQLite file. Logs reflect what HAPPENED; this reflects what's STORED.
// Owner-agnostic on purpose: it's ops/verification tooling behind the DEBUG_TOKEN gate, not a
// user-facing read path (the chat UI uses the tRPC chat router, which IS owner-scoped).

import { asc, count, desc, eq, getTableName, inArray, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "../../../db/client";
import {
  assets,
  characterEmbeddings,
  characters,
  characterTags,
  characterVersions,
  chatEvents,
  chats,
  chatTags,
  imageEmbeddings,
  messages,
  messageVariants,
  personas,
  personaTags,
  presets,
  presetTags,
  presetVersions,
  sessionEntries,
  tags,
  users,
  worldBooks,
  worldBookTags,
  worldEntries,
} from "../../../db/schema";
import { getLog } from "../../observability/logger";

type MessageRow = typeof messages.$inferSelect;
type VariantRow = typeof messageVariants.$inferSelect;

export interface DebugStats {
  tables: Record<string, number>;
  generatedAt: number;
}

export interface IntegrityReport {
  /** true when foreign_key_check returned no rows AND integrity_check is "ok". */
  ok: boolean;
  /** Raw PRAGMA foreign_key_check rows (each = a violated FK: table/rowid/parent/fkid). */
  foreignKeyViolations: Record<string, unknown>[];
  /** PRAGMA integrity_check output ("ok" = clean). */
  integrityCheck: string[];
}

export interface ChatInspection {
  found: boolean;
  chat: typeof chats.$inferSelect | null;
  character: { versionId: string; name: string; version: number } | null;
  /** Messages in seq order, each with ALL provenance columns + its swipe variants. */
  messages: (MessageRow & { variants: VariantRow[] })[];
  /** session_entries frames for the chat's current sessionId (the agent-sdk resume substrate). */
  sessionFrameCount: number;
  /** Recent durable events for the chat (compaction/retry/rate-limit/…), newest first. */
  recentEvents: (typeof chatEvents.$inferSelect)[];
}

export interface DebugService {
  stats(): Promise<DebugStats>;
  integrity(): Promise<IntegrityReport>;
  inspectChat(chatId: string): Promise<ChatInspection>;
}

// Tables we report row counts for (the owned-entity backbone + the RAG/asset tables). Driven off
// the schema objects (getTableName) so a rename can't silently drift the labels.
const COUNTED_TABLES: SQLiteTable[] = [
  users,
  personas,
  characters,
  characterVersions,
  chats,
  messages,
  messageVariants,
  worldBooks,
  worldEntries,
  presets,
  presetVersions,
  sessionEntries,
  chatEvents,
  characterEmbeddings,
  imageEmbeddings,
  assets,
  tags,
  characterTags,
  chatTags,
  worldBookTags,
  personaTags,
  presetTags,
];

export function createDebugService(db: Db): DebugService {
  // count(*) via a raw query keyed on the schema's table name. NOTE (docs/conventions.md): count(*)
  // can read 0 on a vector-indexed table in some bindings — embeddings is the one to eyeball.
  async function countRows(table: SQLiteTable): Promise<number> {
    const rows = await db.select({ n: count() }).from(table);
    return Number(rows[0]?.n ?? 0);
  }

  return {
    async stats() {
      const entries = await Promise.all(
        COUNTED_TABLES.map(async (t) => [getTableName(t), await countRows(t)] as const),
      );
      return { tables: Object.fromEntries(entries), generatedAt: Date.now() };
    },

    async integrity() {
      const fk = await db.all<Record<string, unknown>>(sql`PRAGMA foreign_key_check`);
      const ic = await db.all<Record<string, unknown>>(sql`PRAGMA integrity_check`);
      // integrity_check returns one unnamed column per row — take the value without keying on the
      // (snake_case) column name (sidesteps the Biome⇄tsc literal-key dance).
      const integrityCheck = ic
        .map((r) => String(Object.values(r)[0] ?? ""))
        .filter((s) => s.length > 0);
      const ok = fk.length === 0 && integrityCheck.every((s) => s === "ok");
      if (!ok) {
        getLog().warn(
          { fkViolations: fk.length, integrityCheck },
          "debug: db integrity check found issues",
        );
      }
      return { ok, foreignKeyViolations: fk, integrityCheck };
    },

    async inspectChat(chatId) {
      const chatRow =
        (await db.select().from(chats).where(eq(chats.id, chatId)).limit(1))[0] ?? null;
      if (chatRow === null) {
        return {
          found: false,
          chat: null,
          character: null,
          messages: [],
          sessionFrameCount: 0,
          recentEvents: [],
        };
      }

      const character =
        (
          await db
            .select({
              versionId: characterVersions.id,
              name: characterVersions.name,
              version: characterVersions.version,
            })
            .from(characterVersions)
            .where(eq(characterVersions.id, chatRow.characterVersionId))
            .limit(1)
        )[0] ?? null;

      const msgRows = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(asc(messages.seq));

      const ids = msgRows.map((m) => m.id);
      const variantRows =
        ids.length > 0
          ? await db
              .select()
              .from(messageVariants)
              .where(inArray(messageVariants.messageId, ids))
              .orderBy(asc(messageVariants.idx))
          : [];
      const byMessage = new Map<string, VariantRow[]>();
      for (const v of variantRows) {
        const list = byMessage.get(v.messageId) ?? [];
        list.push(v);
        byMessage.set(v.messageId, list);
      }

      let sessionFrameCount = 0;
      if (chatRow.sessionId !== null) {
        const rows = await db
          .select({ n: sql<number>`count(*)` })
          .from(sessionEntries)
          .where(eq(sessionEntries.sessionId, chatRow.sessionId));
        sessionFrameCount = Number(rows[0]?.n ?? 0);
      }

      const recentEvents = await db
        .select()
        .from(chatEvents)
        .where(eq(chatEvents.chatId, chatId))
        .orderBy(desc(chatEvents.at))
        .limit(50);

      return {
        found: true,
        chat: chatRow,
        character,
        messages: msgRows.map((m) => ({ ...m, variants: byMessage.get(m.id) ?? [] })),
        sessionFrameCount,
        recentEvents,
      };
    },
  };
}
