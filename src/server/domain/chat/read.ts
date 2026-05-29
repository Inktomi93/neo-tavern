import { and, desc, eq } from "drizzle-orm";
import { assets, characterVersions, chats } from "../../../db/schema";
import { assemblePrompt } from "../../../shared/prompt-assemble";
import { ensureUser } from "../_shared/users";
import type { ChatContext } from "./context/factory";
import { buildPromptTrace } from "./helpers";
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

  const ChatSummarySelect = {
    id: chats.id,
    title: chats.title,
    characterName: characterVersions.name,
    avatarHash: assets.hash,
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
  } as const;

  // biome-ignore lint/suspicious/noExplicitAny: generic drizzle result row
  function mapChatSummary(r: any): ChatSummary {
    return {
      id: r.id,
      title: r.title,
      characterName: r.characterName,
      avatarHash: r.avatarHash ?? null,
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
    };
  }

  async function listChats(params: { username: string }): Promise<ChatSummary[]> {
    const ownerId = await ensureUser(db, params.username);
    const rows = await db
      .select(ChatSummarySelect)
      .from(chats)
      .leftJoin(characterVersions, eq(chats.characterVersionId, characterVersions.id))
      .leftJoin(assets, eq(characterVersions.avatarAssetId, assets.id))
      .where(eq(chats.ownerId, ownerId))
      .orderBy(desc(chats.updatedAt));
    return rows.map(mapChatSummary);
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
      trace: buildPromptTrace(systemPrompt, assembleCtx),
    };
  }

  async function getChat(params: { username: string; chatId: string }): Promise<ChatDetail> {
    const ownerId = await ensureUser(db, params.username);
    const rows = await db
      .select({
        ...ChatSummarySelect,
        characterId: characterVersions.characterId,
        characterVersionId: chats.characterVersionId,
        personaId: chats.personaId,
        pinnedPersonaId: chats.pinnedPersonaId,
        presetVersionId: chats.presetVersionId,
        parentChatId: chats.parentChatId,
        forkedAt: chats.forkedAt,
        sessionId: chats.sessionId,
      })
      .from(chats)
      .leftJoin(characterVersions, eq(chats.characterVersionId, characterVersions.id))
      .leftJoin(assets, eq(characterVersions.avatarAssetId, assets.id))
      .where(and(eq(chats.ownerId, ownerId), eq(chats.id, params.chatId)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      await loadOwnedChat(ownerId, params.chatId); // throws the correct not_found error
      throw new Error("unreachable");
    }

    return {
      ...mapChatSummary(row),
      characterId: row.characterId ?? null,
      characterVersionId: row.characterVersionId,
      personaId: row.personaId,
      pinnedPersonaId: row.pinnedPersonaId,
      presetVersionId: row.presetVersionId,
      parentChatId: row.parentChatId,
      forkedAt: row.forkedAt,
      hasSession: row.sessionId !== null,
    };
  }

  return { listChats, getChat, listMessages, previewAssembly };
}
