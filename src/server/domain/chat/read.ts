import { desc, eq } from "drizzle-orm";
import { characterVersions, chats } from "../../../db/schema";
import { assemblePrompt } from "../../../shared/prompt-assemble";
import { ensureUser } from "../_shared/users";
import type { ChatContext } from "./context";
import { resolveTurnRouting } from "./routing";
import type { AssemblyPreview, ChatDetail, ChatSummary, MessageView } from "./types";

/**
 * Read ops: the model-free query surface — `listChats`, `getChat`, `listMessages`, and the
 * `previewAssembly` dry-run ("what would the next turn send", reusing the exact send() helpers).
 */
export function createRead(ctx: ChatContext) {
  const { db, loadOwnedChat, listByChat, buildAssembleContext, resolveConfig } = ctx;

  async function listMessages(params: {
    username: string;
    chatId: string;
  }): Promise<MessageView[]> {
    const ownerId = await ensureUser(db, params.username);
    await loadOwnedChat(ownerId, params.chatId); // ownership check
    return listByChat(params.chatId);
  }

  async function listChats(params: { username: string }): Promise<ChatSummary[]> {
    const ownerId = await ensureUser(db, params.username);
    const rows = await db
      .select({
        id: chats.id,
        title: chats.title,
        characterName: characterVersions.name,
        api: chats.api,
        source: chats.source,
        model: chats.model,
        messageCount: chats.messageCount,
        totalTokensIn: chats.totalTokensIn,
        totalTokensOut: chats.totalTokensOut,
        starred: chats.starred,
        archived: chats.archived,
        createdAt: chats.createdAt,
        updatedAt: chats.updatedAt,
      })
      .from(chats)
      .leftJoin(characterVersions, eq(chats.characterVersionId, characterVersions.id))
      .where(eq(chats.ownerId, ownerId))
      .orderBy(desc(chats.updatedAt));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      characterName: r.characterName,
      api: r.api,
      source: r.source,
      model: r.model,
      messageCount: r.messageCount ?? 0,
      totalTokensIn: r.totalTokensIn ?? 0,
      totalTokensOut: r.totalTokensOut ?? 0,
      starred: r.starred ?? false,
      archived: r.archived ?? false,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  // Dry-run the prompt assembly + routing for a chat's NEXT turn — no model call. Reuses the exact
  // same helpers send() does, so what you preview is what a turn would actually send.
  async function previewAssembly(params: {
    username: string;
    chatId: string;
  }): Promise<AssemblyPreview> {
    const ownerId = await ensureUser(db, params.username);
    const chat = await loadOwnedChat(ownerId, params.chatId);
    const [assembleCtx, promptConfig] = await Promise.all([
      buildAssembleContext(chat),
      resolveConfig(chat),
    ]);
    const systemPrompt = assemblePrompt(promptConfig, assembleCtx);
    const routing = resolveTurnRouting(chat, promptConfig);
    return {
      routing: {
        runner: routing.runner,
        api: routing.api,
        source: routing.source,
        model: routing.model,
      },
      preset: chat.presetVersionId === null ? "default" : "pinned",
      systemPrompt: { static: systemPrompt.static, dynamic: systemPrompt.dynamic },
      trace: {
        staticChars: systemPrompt.static.length,
        dynamicChars: systemPrompt.dynamic.length,
        staticSections: systemPrompt.trace.staticSections,
        dynamicSections: systemPrompt.trace.dynamicSections,
        worldInfoAttached: assembleCtx.worldEntries.length,
        worldInfoIncluded: systemPrompt.trace.worldInfoIncluded,
        matchedKeys: systemPrompt.trace.matchedKeys,
        hasPersona: assembleCtx.activePersona !== null,
      },
    };
  }

  async function getChat(params: { username: string; chatId: string }): Promise<ChatDetail> {
    const ownerId = await ensureUser(db, params.username);
    const chat = await loadOwnedChat(ownerId, params.chatId); // throws ChatNotFoundError if unowned
    const cv = (
      await db
        .select({ name: characterVersions.name, characterId: characterVersions.characterId })
        .from(characterVersions)
        .where(eq(characterVersions.id, chat.characterVersionId))
        .limit(1)
    )[0];
    return {
      id: chat.id,
      title: chat.title,
      characterName: cv?.name ?? null,
      api: chat.api,
      source: chat.source,
      model: chat.model,
      messageCount: chat.messageCount ?? 0,
      totalTokensIn: chat.totalTokensIn ?? 0,
      totalTokensOut: chat.totalTokensOut ?? 0,
      starred: chat.starred ?? false,
      archived: chat.archived ?? false,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      characterId: cv?.characterId ?? null,
      characterVersionId: chat.characterVersionId,
      personaId: chat.personaId,
      pinnedPersonaId: chat.pinnedPersonaId,
      presetVersionId: chat.presetVersionId,
      parentChatId: chat.parentChatId,
      forkedAt: chat.forkedAt,
      hasSession: chat.sessionId !== null,
    };
  }

  return { listChats, getChat, listMessages, previewAssembly };
}
