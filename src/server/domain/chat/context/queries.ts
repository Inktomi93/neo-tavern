import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Db } from "../../../../db/client";
import { chatEvents, chats, messages, sessionEntries } from "../../../../db/schema";
import type { TurnEvent } from "../../../providers/turn";
import { newId } from "../../_shared/ids";
import { ChatNotFoundError, ChatOperationError, type MessageView } from "../types";

export function frameContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((b) =>
      b !== null && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .join("");
}

export function toView(row: typeof messages.$inferSelect, variantCount: number): MessageView {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    model: row.model,
    provider: row.provider,
    stopReason: row.stopReason,
    finishReason: row.finishReason,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    contextWindow: row.contextWindow,
    costUsd: row.costUsd,
    ttftMs: row.ttftMs,
    terminalReason: row.terminalReason,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    activeVariantIdx: row.activeVariantIdx,
    variantCount,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: Prepared statement cache
const loadOwnedChatCache = new WeakMap<Db, any>();

export async function loadOwnedChat(
  db: Db,
  ownerId: string,
  chatId: string,
): Promise<typeof chats.$inferSelect> {
  let query = loadOwnedChatCache.get(db);
  if (!query) {
    query = db
      .select()
      .from(chats)
      .where(
        and(eq(chats.id, sql.placeholder("chatId")), eq(chats.ownerId, sql.placeholder("ownerId"))),
      )
      .limit(1)
      .prepare();
    loadOwnedChatCache.set(db, query);
  }
  const rows = await query.execute({ chatId, ownerId });
  const chat = rows[0];
  if (!chat) {
    throw new ChatNotFoundError(chatId);
  }
  return chat;
}

export async function listByChat(db: Db, chatId: string): Promise<MessageView[]> {
  const rows = await db.query.messages.findMany({
    where: eq(messages.chatId, chatId),
    orderBy: asc(messages.seq),
    with: { variants: { columns: { id: true } } },
  });
  return rows.map((r) => toView(r, r.variants.length));
}

export async function recordTurnEvents(
  db: Db,
  chatId: string,
  messageId: string | null,
  events: TurnEvent[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const now = Date.now();
  await db.insert(chatEvents).values(
    events.map((event) => ({
      id: newId(),
      chatId,
      messageId,
      kind: event.kind,
      at: event.at,
      data: event,
      createdAt: now,
    })),
  );
}

export async function extractCompactSummary(db: Db, sessionId: string): Promise<string | null> {
  const rows = await db
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(and(eq(sessionEntries.sessionId, sessionId), eq(sessionEntries.type, "user")))
    .orderBy(desc(sessionEntries.seq))
    .limit(10);
  for (const row of rows) {
    const frame = row.entry;
    if (frame === null || typeof frame !== "object") {
      continue;
    }
    const message = (frame as { message?: unknown }).message;
    const content = (message as { content?: unknown } | undefined)?.content;
    const text = frameContentToText(content);
    if (text.toLowerCase().includes("session is being continued")) {
      return text;
    }
  }
  return null;
}

// biome-ignore lint/suspicious/noExplicitAny: Prepared statement cache
const maxSeqCache = new WeakMap<Db, any>();

export async function maxSeq(db: Db, chatId: string): Promise<number> {
  let query = maxSeqCache.get(db);
  if (!query) {
    query = db
      .select({ seq: messages.seq })
      .from(messages)
      .where(eq(messages.chatId, sql.placeholder("chatId")))
      .orderBy(desc(messages.seq))
      .limit(1)
      .prepare();
    maxSeqCache.set(db, query);
  }
  const last = await query.execute({ chatId });
  return last[0]?.seq ?? 0;
}

export async function loadCanonHistory(
  db: Db,
  chatId: string,
  bounds: { beforeSeq?: number | undefined; afterSeq?: number | undefined } = {},
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const filters = [eq(messages.chatId, chatId)];
  if (bounds.beforeSeq !== undefined) {
    filters.push(lt(messages.seq, bounds.beforeSeq));
  }
  if (bounds.afterSeq !== undefined) {
    filters.push(gt(messages.seq, bounds.afterSeq));
  }
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(...filters))
    .orderBy(asc(messages.seq));
  return rows
    .filter((r): r is { role: "user" | "assistant"; content: string } => r.role !== "system")
    .map((r) => ({ role: r.role, content: r.content }));
}

// biome-ignore lint/suspicious/noExplicitAny: Prepared statement cache
const loadOwnedMessageCache = new WeakMap<Db, any>();

export async function loadOwnedMessage(
  db: Db,
  chatId: string,
  messageId: string,
): Promise<typeof messages.$inferSelect> {
  let query = loadOwnedMessageCache.get(db);
  if (!query) {
    query = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, sql.placeholder("messageId")),
          eq(messages.chatId, sql.placeholder("chatId")),
        ),
      )
      .limit(1)
      .prepare();
    loadOwnedMessageCache.set(db, query);
  }
  const rows = await query.execute({ messageId, chatId });
  const msg = rows[0];
  if (!msg) {
    throw new ChatOperationError("no_such_message", `message ${messageId} not in chat ${chatId}`);
  }
  return msg;
}
