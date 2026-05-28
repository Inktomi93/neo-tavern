import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  characters,
  characterVersions,
  chats,
  messages,
  messageVariants,
} from "../../../db/schema";
import { assemblePrompt } from "../../../shared/prompt-assemble";
import { getLog } from "../../observability/logger";
import { TurnError } from "../../providers/turn";
import { newId } from "../_shared/ids";
import { withChatLock } from "../_shared/lock";
import { ensureUser } from "../_shared/users";
import { OPEN_SCENE_PROMPT } from "./constants";
import type { ChatContext } from "./context";
import { resolveTurnRouting } from "./routing";
import { buildSeedFrames, GREETING_USER_STUB } from "./seed";
import { DbSessionStore } from "./store";
import type { CreateChatParams, EditMessageParams, MessageView } from "./types";

/**
 * Lifecycle ops: `create` (skeleton character + v1 + chat, opening via greeting/generated/blank),
 * its internal `generateOpening` helper (the "generate to open" toggle), and `editMessage`
 * (in-place edit + sdk re-seed).
 */
export function createLifecycle(ctx: ChatContext) {
  const { db, loadOwnedChat, loadOwnedMessage, listByChat, runTurn, recordTurnEvents } = ctx;
  const { buildAssembleContext, resolveConfig, reseedSdkSession } = ctx;

  async function create(params: CreateChatParams): Promise<{ chatId: string }> {
    const ownerId = await ensureUser(db, params.username);
    const now = Date.now();
    const characterId = newId();
    const versionId = newId();
    const chatId = newId();

    // Minimal character + v1 inline (the skeleton owns this; a real characters domain takes over
    // later). The form's first message becomes greetings[0]. Circular FK (characters.currentVersionId
    // ↔ character_versions.characterId, migration 0007): insert the character with a NULL
    // currentVersionId, then the version, then repoint — same order the importer uses.
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
      greetings: params.firstMessage ? [params.firstMessage] : [],
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
      // api/source default to agent-sdk + max-pro-sub (free Claude on the sub) via the schema;
      // model left null → resolveTurnRouting falls back to DEFAULT_CHAT_MODEL_ID.
      createdAt: now,
      updatedAt: now,
    });

    // How the chat opens:
    //  • greeting present → seed greetings[0] as the opening (message row #1 + sdk session seed).
    //  • else + generateOpeningIfEmpty → the model writes the opening (a no-user-message turn).
    //  • else → blank; the user speaks first.
    const greeting = (params.firstMessage ?? "").trim();
    if (greeting.length > 0) {
      const sessionId = randomUUID();
      await db.insert(messages).values({
        id: newId(),
        chatId,
        seq: 1,
        role: "assistant",
        content: greeting,
        createdAt: now,
      });
      // Seed the sdk session so turn 1's resume sees the greeting. A greeting has no real user turn
      // before it, so prefix the ST invisible-user stub → the validated user→assistant seed shape
      // (./seed; the stub is session-only, never a messages row, so the UI never shows it).
      await new DbSessionStore(db, chatId).append(
        { projectKey: chatId, sessionId },
        buildSeedFrames(
          [
            { role: "user", content: GREETING_USER_STUB },
            { role: "assistant", content: greeting },
          ],
          sessionId,
        ),
      );
      await db.update(chats).set({ sessionId, messageCount: 1 }).where(eq(chats.id, chatId));
    } else if (params.generateOpeningIfEmpty === true) {
      await generateOpening(ownerId, chatId);
    }

    return { chatId };
  }

  // "Generate to open" (the create-time toggle): the model writes the first message in-character via
  // a no-user-message turn — a hidden open-scene prompt (never stored as a messages row) elicits the
  // opening, and runTurn lets the SDK build the session. Graceful: a provider failure leaves the chat
  // blank (the user can just speak first) rather than failing creation.
  async function generateOpening(ownerId: string, chatId: string): Promise<void> {
    const chat = await loadOwnedChat(ownerId, chatId);
    const [assembleCtx, promptConfig] = await Promise.all([
      buildAssembleContext(chat),
      resolveConfig(chat),
    ]);
    const routing = resolveTurnRouting(chat, promptConfig);
    if (routing.runner !== "agent-sdk") {
      return; // create() only makes agent-sdk chats; an openrouter opening would route through runRaw
    }
    try {
      const turn = await runTurn({
        prompt: OPEN_SCENE_PROMPT,
        model: routing.model,
        source: routing.source,
        sessionStore: new DbSessionStore(db, chatId),
        systemPrompt: assemblePrompt(promptConfig, assembleCtx),
        generation: promptConfig.params,
      });
      const openingMsgId = newId();
      await db.insert(messages).values({
        id: openingMsgId,
        chatId,
        seq: 1,
        role: "assistant",
        content: turn.reply,
        model: turn.usage.model,
        provider: `${routing.api}/${routing.source}`,
        stopReason: turn.stopReason,
        finishReason: turn.finishReason,
        reasoningEffort: promptConfig.params.effort ?? null,
        tokensIn: turn.usage.tokensIn,
        tokensOut: turn.usage.tokensOut,
        cacheReadTokens: turn.usage.cacheReadTokens,
        cacheWriteTokens: turn.usage.cacheWriteTokens,
        cacheCreation5mTokens: turn.usage.cacheCreation5mTokens,
        cacheCreation1hTokens: turn.usage.cacheCreation1hTokens,
        contextWindow: turn.usage.contextWindow,
        maxOutputTokens: turn.usage.maxOutputTokens,
        ttftMs: turn.ttftMs,
        terminalReason: turn.terminalReason,
        apiErrorStatus: turn.apiErrorStatus,
        costUsd: turn.usage.costUsd,
        createdAt: Date.now(),
      });
      await recordTurnEvents(chatId, openingMsgId, turn.events);
      await db
        .update(chats)
        .set({
          sessionId: turn.sessionId,
          messageCount: 1,
          totalTokensIn: turn.usage.tokensIn,
          totalTokensOut: turn.usage.tokensOut,
          updatedAt: Date.now(),
        })
        .where(eq(chats.id, chatId));
      getLog().info({ chatId }, "chat: generated opening message");
    } catch (error) {
      if (error instanceof TurnError) {
        getLog().warn(
          { chatId, kind: error.kind },
          "chat: opening generation failed — chat starts blank",
        );
        return;
      }
      throw error;
    }
  }

  // Edit a message in place (any message, including buried). Updates content (+ the active variant's
  // text) and re-seeds the sdk session so the model sees the edit on the next turn. No model call.
  async function editMessage(params: EditMessageParams): Promise<MessageView[]> {
    const ownerId = await ensureUser(db, params.username);
    return withChatLock(params.chatId, async () => {
      const chat = await loadOwnedChat(ownerId, params.chatId);
      const msg = await loadOwnedMessage(params.chatId, params.messageId);
      const now = Date.now();
      await db
        .update(messages)
        .set({ content: params.content, editedAt: now })
        .where(eq(messages.id, params.messageId));
      if (msg.activeVariantIdx !== null) {
        await db
          .update(messageVariants)
          .set({ content: params.content })
          .where(
            and(
              eq(messageVariants.messageId, params.messageId),
              eq(messageVariants.idx, msg.activeVariantIdx),
            ),
          );
      }
      const newSessionId = await reseedSdkSession(chat);
      if (newSessionId !== null) {
        await db
          .update(chats)
          .set({ sessionId: newSessionId, updatedAt: now })
          .where(eq(chats.id, params.chatId));
      }
      getLog().info(
        { chatId: params.chatId, messageId: params.messageId, seq: msg.seq },
        "chat: message edited",
      );
      return listByChat(params.chatId);
    });
  }

  async function deleteChat(params: {
    username: string;
    chatId: string;
  }): Promise<{ deleted: boolean }> {
    const ownerId = await ensureUser(db, params.username);
    return withChatLock(params.chatId, async () => {
      await loadOwnedChat(ownerId, params.chatId);
      // DB has ON DELETE CASCADE for messages, variants, etc.
      await db.delete(chats).where(eq(chats.id, params.chatId));
      getLog().info({ chatId: params.chatId }, "chat: deleted");
      return { deleted: true };
    });
  }

  async function updateTitle(params: {
    username: string;
    chatId: string;
    title: string;
  }): Promise<void> {
    const ownerId = await ensureUser(db, params.username);
    return withChatLock(params.chatId, async () => {
      await loadOwnedChat(ownerId, params.chatId);
      await db
        .update(chats)
        .set({ title: params.title, updatedAt: Date.now() })
        .where(eq(chats.id, params.chatId));
    });
  }

  async function star(params: {
    username: string;
    chatId: string;
    starred: boolean;
  }): Promise<void> {
    const ownerId = await ensureUser(db, params.username);
    return withChatLock(params.chatId, async () => {
      await loadOwnedChat(ownerId, params.chatId);
      await db
        .update(chats)
        .set({ starred: params.starred, updatedAt: Date.now() })
        .where(eq(chats.id, params.chatId));
    });
  }

  async function archive(params: {
    username: string;
    chatId: string;
    archived: boolean;
  }): Promise<void> {
    const ownerId = await ensureUser(db, params.username);
    return withChatLock(params.chatId, async () => {
      await loadOwnedChat(ownerId, params.chatId);
      await db
        .update(chats)
        .set({ archived: params.archived, updatedAt: Date.now() })
        .where(eq(chats.id, params.chatId));
    });
  }

  return { create, editMessage, delete: deleteChat, updateTitle, star, archive };
}
