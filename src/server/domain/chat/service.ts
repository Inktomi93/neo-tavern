import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characters, characterVersions, chats, messages } from "../../../db/schema";
import { DEFAULT_CHAT_MODEL_ID } from "../../../shared/models";
import { getLog } from "../../observability/logger";
import { type ChatTurnResult, runChatTurn } from "../../providers/claude-sdk";
import { newId } from "../_shared/ids";
import { withChatLock } from "../_shared/lock";
import { ensureUser } from "../_shared/users";
import { DbSessionStore } from "./store";
import {
  ChatNotFoundError,
  type ChatService,
  type CreateChatParams,
  type MessageView,
  type SendParams,
  type SendResult,
} from "./types";

// The runner is injectable so the turn logic is testable with a fake (no sub queries
// in `pnpm check`); production uses the real SDK turn.
export interface ChatServiceDeps {
  runTurn?: typeof runChatTurn;
}

const PROVIDER = "anthropic-sdk";

export function createChatService(db: Db, deps: ChatServiceDeps = {}): ChatService {
  const runTurn = deps.runTurn ?? runChatTurn;

  function toView(row: typeof messages.$inferSelect): MessageView {
    return {
      id: row.id,
      seq: row.seq,
      role: row.role,
      content: row.content,
      model: row.model,
      createdAt: row.createdAt,
    };
  }

  async function loadOwnedChat(
    ownerId: string,
    chatId: string,
  ): Promise<typeof chats.$inferSelect> {
    const rows = await db
      .select()
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.ownerId, ownerId)))
      .limit(1);
    const chat = rows[0];
    if (!chat) {
      throw new ChatNotFoundError(chatId);
    }
    return chat;
  }

  async function listByChat(chatId: string): Promise<MessageView[]> {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messages.seq));
    return rows.map(toView);
  }

  async function maxSeq(chatId: string): Promise<number> {
    const last = await db
      .select({ seq: messages.seq })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.seq))
      .limit(1);
    return last[0]?.seq ?? 0;
  }

  async function create(params: CreateChatParams): Promise<{ chatId: string }> {
    const ownerId = await ensureUser(db, params.username);
    const now = Date.now();
    const characterId = newId();
    const versionId = newId();
    const chatId = newId();

    // Minimal character + v1 inline (the skeleton owns this; a real characters domain
    // takes over later). firstMessage is stored on the version but NOT seeded as a
    // message yet — greeting-as-assistant-turn seeding into session_entries is a
    // follow-up (see docs/sdk-notes.md). The chat starts empty; the user opens it.
    // Circular FK (characters.currentVersionId ↔ character_versions.characterId, migration
    // 0007): insert the character with a NULL currentVersionId, then the version, then repoint
    // — same order the importer uses. Setting currentVersionId up front violates the FK.
    await db.insert(characters).values({
      id: characterId,
      ownerId,
      handle: newId(),
      createdAt: now,
    });
    await db.insert(characterVersions).values({
      id: versionId,
      characterId,
      version: 1,
      name: params.characterName,
      description: params.characterDescription,
      firstMessage: params.firstMessage ?? null,
      createdAt: now,
    });
    await db
      .update(characters)
      .set({ currentVersionId: versionId })
      .where(eq(characters.id, characterId));
    await db.insert(chats).values({
      id: chatId,
      ownerId,
      title: params.title,
      characterVersionId: versionId,
      mode: "sdk",
      provider: PROVIDER,
      createdAt: now,
      updatedAt: now,
    });

    return { chatId };
  }

  async function listMessages(params: {
    username: string;
    chatId: string;
  }): Promise<MessageView[]> {
    const ownerId = await ensureUser(db, params.username);
    await loadOwnedChat(ownerId, params.chatId); // ownership check
    return listByChat(params.chatId);
  }

  async function send(params: SendParams): Promise<SendResult> {
    const ownerId = await ensureUser(db, params.username);

    // One generation in flight per chat (also guards concurrent SDK resumes).
    return withChatLock(params.chatId, async (): Promise<SendResult> => {
      const chat = await loadOwnedChat(ownerId, params.chatId);

      // Optimistic concurrency: a stale device never injects an incoherent turn.
      const currentMax = await maxSeq(params.chatId);
      if (currentMax !== params.expectedSeq) {
        return {
          status: "stale",
          messages: await listByChat(params.chatId),
          latestSeq: currentMax,
        };
      }

      const userSeq = currentMax + 1;
      await db.insert(messages).values({
        id: newId(),
        chatId: params.chatId,
        seq: userSeq,
        role: "user",
        content: params.content,
        createdAt: Date.now(),
      });

      const store = new DbSessionStore(db, params.chatId);
      const turn: ChatTurnResult = await runTurn({
        prompt: params.content,
        model: DEFAULT_CHAT_MODEL_ID,
        sessionStore: store,
        ...(chat.sessionId ? { resume: chat.sessionId } : {}),
      });

      await db.insert(messages).values({
        id: newId(),
        chatId: params.chatId,
        seq: userSeq + 1,
        role: "assistant",
        content: turn.reply,
        model: turn.usage.model,
        provider: PROVIDER,
        stopReason: turn.stopReason,
        tokensIn: turn.usage.tokensIn,
        tokensOut: turn.usage.tokensOut,
        cacheReadTokens: turn.usage.cacheReadTokens,
        cacheWriteTokens: turn.usage.cacheWriteTokens,
        costUsd: turn.usage.costUsd,
        createdAt: Date.now(),
      });

      await db
        .update(chats)
        .set({
          sessionId: turn.sessionId || chat.sessionId,
          messageCount: (chat.messageCount ?? 0) + 2,
          totalTokensIn: (chat.totalTokensIn ?? 0) + turn.usage.tokensIn,
          totalTokensOut: (chat.totalTokensOut ?? 0) + turn.usage.tokensOut,
          updatedAt: Date.now(),
        })
        .where(eq(chats.id, params.chatId));

      getLog().debug({ chatId: params.chatId, seq: userSeq + 1 }, "chat turn complete");
      return { status: "ok", messages: await listByChat(params.chatId) };
    });
  }

  return { create, listMessages, send };
}
