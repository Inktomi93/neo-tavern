import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import {
  characters,
  characterVersions,
  characterVersionWorldEntries,
  chatEvents,
  chats,
  chatWorldEntries,
  messages,
  messageVariants,
  personas,
  presetVersions,
  sessionEntries,
  worldEntries,
} from "../../../db/schema";
import {
  type AssembleContext,
  type AssemblePersona,
  type AssembleWorldEntry,
  assemblePrompt,
} from "../../../shared/prompt-assemble";
import {
  DEFAULT_PROMPT_CONFIG,
  type PromptConfig,
  parsePromptConfig,
  type WorldInfoScope,
} from "../../../shared/prompt-config";
import { getLog } from "../../observability/logger";
import { runChatTurn } from "../../providers/claude-sdk";
import { runChatCompletionTurn, runRawTurn } from "../../providers/openrouter";
import { type ChatTurnResult, TurnError, type TurnEvent } from "../../providers/turn";
import { newId } from "../_shared/ids";
import { withChatLock } from "../_shared/lock";
import { ensureUser } from "../_shared/users";
import { resolveTurnRouting } from "./routing";
import { buildSeedFrames, GREETING_USER_STUB, type SeedTurn } from "./seed";
import { DbSessionStore } from "./store";
import {
  type AssemblyPreview,
  type ChatDetail,
  ChatNotFoundError,
  ChatOperationError,
  type ChatService,
  type ChatSummary,
  type CompactParams,
  type CreateChatParams,
  type EditMessageParams,
  type ForkChatParams,
  type MessageView,
  type SelectVariantParams,
  type SendParams,
  type SendResult,
  type SetProviderParams,
  type SwipeParams,
} from "./types";

// Both runners are injectable so the turn logic is testable with fakes (no sub queries / no
// network in `pnpm check`); production uses the real adapters. Which one runs is decided per
// turn by resolveTurnRouting (./routing), the single owner of model + provider selection.
export interface ChatServiceDeps {
  runTurn?: typeof runChatTurn;
  runRaw?: typeof runRawTurn;
  runChatCompletion?: typeof runChatCompletionTurn;
}

// Recent message texts the keyword-WI marker scans. Small + tunable; includes the just-inserted
// user message (send inserts it before assembling), which is what should trigger keyword WI.
const RECENT_MESSAGE_WINDOW = 6;

// The hidden "user" turn that elicits a generated opening (generateOpeningIfEmpty). Never stored as
// a messages row — it only prompts the model to write the character's first message.
const OPEN_SCENE_PROMPT =
  "[Open the scene: write your first message to me, in character — set the scene and greet me as your character would. Stay fully in character.]";

// Default steering for a manual `/compact` (compaction mode "off"). RP-tuned vs the SDK's generic
// coding-agent summary (which recalls early canon unreliably for tool-less RP — docs/sdk-notes.md).
const DEFAULT_COMPACT_INSTRUCTIONS =
  "Summarize the roleplay so far for continuation: preserve each character's voice and persona, the relationships and their current state, established facts and world details, unresolved threads, and the present scene/location. Be concise but lossless on canon — names, commitments, and specific details must survive.";

export function createChatService(db: Db, deps: ChatServiceDeps = {}): ChatService {
  const runTurn = deps.runTurn ?? runChatTurn;
  const runRaw = deps.runRaw ?? runRawTurn;
  const runChatCompletion = deps.runChatCompletion ?? runChatCompletionTurn;

  // The openrouter runner picks the endpoint by api: chat.send (broad catalog) vs beta.responses.
  function openRouterRunner(api: "chat-completions" | "responses"): typeof runRawTurn {
    return api === "chat-completions" ? runChatCompletion : runRaw;
  }

  function toView(row: typeof messages.$inferSelect, variantCount: number): MessageView {
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
    if (rows.length === 0) {
      return [];
    }
    // Variant (swipe) counts per message, one grouped query — drives the "n / m" counter.
    const counts = new Map<string, number>();
    const vc = await db
      .select({ messageId: messageVariants.messageId, n: sql<number>`count(*)` })
      .from(messageVariants)
      .where(
        inArray(
          messageVariants.messageId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(messageVariants.messageId);
    for (const v of vc) {
      counts.set(v.messageId, Number(v.n));
    }
    return rows.map((r) => toView(r, counts.get(r.id) ?? 0));
  }

  // Persist a turn's structured events (compaction / retry / rate-limit / status / auth) to the
  // durable chat_events history — the in-memory log ring resets on restart, this doesn't. Metadata
  // only (the TurnEvent payloads carry no RP content). No-op when a turn produced none.
  async function recordTurnEvents(
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

  async function maxSeq(chatId: string): Promise<number> {
    const last = await db
      .select({ seq: messages.seq })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.seq))
      .limit(1);
    return last[0]?.seq ?? 0;
  }

  function toWorldEntry(
    row: {
      content: string;
      enabled: boolean | null;
      priority: number | null;
      legacyKeys: unknown;
      scope: string | null;
    },
    source: AssembleWorldEntry["source"],
  ): AssembleWorldEntry {
    const scope: WorldInfoScope = row.scope === "keyword" ? "keyword" : "always";
    const keys = Array.isArray(row.legacyKeys)
      ? row.legacyKeys.filter((k): k is string => typeof k === "string")
      : [];
    return {
      content: row.content,
      scope,
      keys,
      priority: row.priority ?? 0,
      enabled: row.enabled ?? true,
      source,
    };
  }

  // Load the chat's data into an assembly context: the character version, the PINNED persona
  // (chats.personaId — the native "persona pin": {{user}} resolves from the chat's bound persona,
  // immune to any later global-persona change, no card mutation), attached world-info from BOTH
  // junctions (chat-level + character-version-level), and the recent messages for keyword-WI.
  async function buildAssembleContext(chat: typeof chats.$inferSelect): Promise<AssembleContext> {
    const cvRows = await db
      .select()
      .from(characterVersions)
      .where(eq(characterVersions.id, chat.characterVersionId))
      .limit(1);
    const cv = cvRows[0];

    // The chat's persona. Today it serves as BOTH the pinned (card-field) and active
    // (user-field) persona; they diverge once persona-switching + a pinned column land.
    let persona: AssemblePersona | null = null;
    if (chat.personaId !== null) {
      const personaRows = await db
        .select({ name: personas.name, description: personas.description })
        .from(personas)
        .where(eq(personas.id, chat.personaId))
        .limit(1);
      persona = personaRows[0] ?? null;
    }

    const wiSelect = {
      content: worldEntries.content,
      enabled: worldEntries.enabled,
      priority: worldEntries.priority,
      legacyKeys: worldEntries.legacyKeys,
    };
    const chatWi = await db
      .select({ ...wiSelect, scope: chatWorldEntries.scope })
      .from(chatWorldEntries)
      .innerJoin(worldEntries, eq(chatWorldEntries.entryId, worldEntries.id))
      .where(eq(chatWorldEntries.chatId, chat.id));
    const cvWi = await db
      .select({ ...wiSelect, scope: characterVersionWorldEntries.scope })
      .from(characterVersionWorldEntries)
      .innerJoin(worldEntries, eq(characterVersionWorldEntries.entryId, worldEntries.id))
      .where(eq(characterVersionWorldEntries.characterVersionId, chat.characterVersionId));

    const recent = await db
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.chatId, chat.id))
      .orderBy(desc(messages.seq))
      .limit(RECENT_MESSAGE_WINDOW);

    return {
      character: cv
        ? {
            name: cv.name,
            description: cv.description,
            personality: cv.personality,
            scenario: cv.scenario,
            exampleMessages: cv.exampleMessages,
            systemPrompt: cv.systemPrompt,
            postHistoryInstructions: cv.postHistoryInstructions,
          }
        : { name: "Assistant", description: "" },
      pinnedPersona: persona,
      activePersona: persona,
      worldEntries: [
        ...chatWi.map((r) => toWorldEntry(r, "chat")),
        ...cvWi.map((r) => toWorldEntry(r, "character")),
      ],
      recentMessages: recent.map((r) => r.content).reverse(),
    };
  }

  // The prompt structure for this chat: its pinned preset version's config, else the default.
  async function resolveConfig(chat: typeof chats.$inferSelect): Promise<PromptConfig> {
    if (chat.presetVersionId === null) {
      return DEFAULT_PROMPT_CONFIG;
    }
    const rows = await db
      .select({ config: presetVersions.config })
      .from(presetVersions)
      .where(eq(presetVersions.id, chat.presetVersionId))
      .limit(1);
    const raw = rows[0]?.config;
    return raw === undefined ? DEFAULT_PROMPT_CONFIG : parsePromptConfig(raw);
  }

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

  // Raw-mode rebuilds the conversation from canon every turn (no SDK session). user/assistant
  // turns only — system content is carried by the assembled `instructions`, not `input`. `beforeSeq`
  // bounds it to seq < beforeSeq (a swipe regenerates the turn from the history BEFORE the user msg).
  async function loadCanonHistory(
    chatId: string,
    beforeSeq?: number,
  ): Promise<{ role: "user" | "assistant"; content: string }[]> {
    const rows = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(
        beforeSeq === undefined
          ? eq(messages.chatId, chatId)
          : and(eq(messages.chatId, chatId), lt(messages.seq, beforeSeq)),
      )
      .orderBy(asc(messages.seq));
    return rows
      .filter((r): r is { role: "user" | "assistant"; content: string } => r.role !== "system")
      .map((r) => ({ role: r.role, content: r.content }));
  }

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
      presetVersionId: chat.presetVersionId,
      parentChatId: chat.parentChatId,
      forkedAt: chat.forkedAt,
      hasSession: chat.sessionId !== null,
    };
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

      // Assemble the character/system prompt from the chat's pinned preset + its character,
      // persona, and attached world-info. Built fresh each turn (the recent-message scan for
      // keyword-WI includes the message just inserted above). static → cached prefix; dynamic →
      // after the boundary. The chat had NO character prompt before this.
      const [assembleCtx, promptConfig] = await Promise.all([
        buildAssembleContext(chat),
        resolveConfig(chat),
      ]);
      const systemPrompt = assemblePrompt(promptConfig, assembleCtx);

      // The single point where model + provider are chosen (no hardcoded model anywhere here).
      // A throw here is a config invariant (incoherent/unimplemented combo) — log it with the
      // chat context the pure resolver lacks, then let it propagate to the tRPC error sink.
      let routing: ReturnType<typeof resolveTurnRouting>;
      try {
        routing = resolveTurnRouting(chat, promptConfig);
      } catch (error) {
        getLog().error(
          {
            chatId: params.chatId,
            api: chat.api,
            source: chat.source,
            model: chat.model,
            err: error instanceof Error ? error.message : String(error),
          },
          "chat: turn routing failed",
        );
        throw error;
      }

      // Prompt assembly + routing are otherwise opaque — log what they produced so "why did/didn't
      // this world-info fire / which persona / which model+provider / how big is the cached prefix"
      // is curl-able via /api/_debug. METADATA ONLY (counts, section ids, trigger keys, ids) —
      // never the prompt text.
      getLog().debug(
        {
          chatId: params.chatId,
          api: routing.api,
          source: routing.source,
          model: routing.model,
          preset: chat.presetVersionId === null ? "default" : "pinned",
          staticChars: systemPrompt.static.length,
          dynamicChars: systemPrompt.dynamic.length,
          staticSections: systemPrompt.trace.staticSections,
          dynamicSections: systemPrompt.trace.dynamicSections,
          worldInfoAttached: assembleCtx.worldEntries.length,
          worldInfoIncluded: systemPrompt.trace.worldInfoIncluded,
          matchedKeys: systemPrompt.trace.matchedKeys,
          hasPersona: assembleCtx.activePersona !== null,
        },
        "chat: prompt assembled",
      );

      let turn: ChatTurnResult;
      try {
        if (routing.runner === "agent-sdk") {
          // agent-sdk runner (Max sub OR OpenRouter skin — `source` picks the env): stateless
          // resume-per-message through our DB-backed SessionStore.
          turn = await runTurn({
            prompt: params.content,
            model: routing.model,
            source: routing.source,
            sessionStore: new DbSessionStore(db, params.chatId),
            systemPrompt,
            generation: promptConfig.params,
            ...(chat.sessionId ? { resume: chat.sessionId } : {}),
          });
        } else {
          // openrouter runner: rebuild the conversation from canon (incl. the user message just
          // inserted) → chat.send or beta.responses (by api). No session store; routing rides through.
          turn = await openRouterRunner(routing.api)({
            model: routing.model,
            systemPrompt,
            history: await loadCanonHistory(params.chatId),
            generation: routing.params,
            providerRouting: routing.providerRouting,
          });
        }
      } catch (error) {
        if (error instanceof TurnError) {
          // Atomic send: the generation failed, so roll the user message back out (no
          // :memory:-safe transaction; the per-chat lock guarantees no racer) — the chat
          // returns to its prior coherent tip and the client surfaces a typed error.
          await db
            .delete(messages)
            .where(and(eq(messages.chatId, params.chatId), eq(messages.seq, userSeq)));
          getLog().warn(
            {
              chatId: params.chatId,
              kind: error.kind,
              retryable: error.retryable,
              apiErrorStatus: error.apiErrorStatus,
              sdkError: error.sdkError,
              resultSubtype: error.resultSubtype,
            },
            "chat turn failed — rolled back user message",
          );
          return {
            status: "error",
            code: error.kind,
            retryable: error.retryable,
            ...(error.resetsAt !== undefined ? { resetsAt: error.resetsAt } : {}),
            messages: await listByChat(params.chatId),
          };
        }
        throw error; // unexpected (non-provider) failure — let it propagate
      }

      const assistantMsgId = newId();
      await db.insert(messages).values({
        id: assistantMsgId,
        chatId: params.chatId,
        seq: userSeq + 1,
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
      await recordTurnEvents(params.chatId, assistantMsgId, turn.events);

      await db
        .update(chats)
        .set({
          // sessionId is an agent-sdk concept (the resume handle); the openrouter runner has none,
          // so don't touch it there (avoid leaning on runRaw returning a falsy sessionId).
          ...(routing.runner === "agent-sdk"
            ? { sessionId: turn.sessionId || chat.sessionId }
            : {}),
          messageCount: (chat.messageCount ?? 0) + 2,
          totalTokensIn: (chat.totalTokensIn ?? 0) + turn.usage.tokensIn,
          totalTokensOut: (chat.totalTokensOut ?? 0) + turn.usage.tokensOut,
          updatedAt: Date.now(),
        })
        .where(eq(chats.id, params.chatId));

      // chatId-scoped turn summary (the provider already logs each event at its own level;
      // this adds the chat context + the context-fill signal the UI will show). INFO (not debug) so
      // cost-per-chat is correlatable at the default LOG_LEVEL — the provider-level "turn complete"
      // carries cost but no chatId, so this is the one line that ties tokens/cost to a chat.
      getLog().info(
        {
          chatId: params.chatId,
          seq: userSeq + 1,
          model: turn.usage.model,
          tokensIn: turn.usage.tokensIn,
          tokensOut: turn.usage.tokensOut,
          costUsd: turn.usage.costUsd,
          contextWindow: turn.usage.contextWindow,
          finishReason: turn.finishReason,
          compactions: turn.events.filter((event) => event.kind === "compaction").length,
          rateLimit: turn.rateLimit?.status,
        },
        "chat turn complete",
      );
      return { status: "ok", messages: await listByChat(params.chatId) };
    });
  }

  // Switch a chat's api/source/model in place (the generalized escape valve — replaces the old
  // one-way sdk→raw convert now that "mode" is gone). The canon always stays; what changes is how
  // the NEXT turn runs + the session handling that implies:
  //   • entering agent-sdk (from the openrouter runner) → seed a session from canon so resume works
  //   • leaving agent-sdk → drop the session (the openrouter runner rebuilds from canon)
  //   • staying on agent-sdk (max↔openrouter) → keep the session (same frame format; only the
  //     credential/endpoint changes)
  // Locked against in-flight sends (same per-chat lock) so we never flip provider mid-turn.
  async function setProvider(params: SetProviderParams): Promise<void> {
    const ownerId = await ensureUser(db, params.username);
    await withChatLock(params.chatId, async () => {
      const chat = await loadOwnedChat(ownerId, params.chatId);
      // Coherence guard (the same invariants resolveTurnRouting enforces, checked before we persist
      // so a bad combo can never be stored): the openrouter-runner apis require source=openrouter.
      if (
        (params.api === "chat-completions" || params.api === "responses") &&
        params.source !== "openrouter"
      ) {
        throw new ChatOperationError(
          "invalid_provider",
          `api=${params.api} requires source=openrouter (got ${params.source})`,
        );
      }

      const enteringAgentSdk = params.api === "agent-sdk" && chat.api !== "agent-sdk";
      const leavingAgentSdk = params.api !== "agent-sdk" && chat.api === "agent-sdk";

      let sessionId = chat.sessionId;
      if (leavingAgentSdk) {
        if (chat.sessionId !== null) {
          await db.delete(sessionEntries).where(eq(sessionEntries.sessionId, chat.sessionId));
        }
        sessionId = null;
      } else if (enteringAgentSdk) {
        // Seed a session from current canon so the first agent-sdk resume sees the branched history
        // (reuses the validated reseed path; reseedSdkSession gates on the CURRENT api, so seed here).
        sessionId = await seedSessionFromCanon(params.chatId);
      }

      await db
        .update(chats)
        .set({
          api: params.api,
          source: params.source,
          // model defaults to null unless the caller picks one (the catalog differs per api/source).
          model: params.model ?? null,
          sessionId,
          convertedAt: Date.now(),
          updatedAt: Date.now(),
        })
        .where(eq(chats.id, params.chatId));
      getLog().info(
        {
          chatId: params.chatId,
          from: `${chat.api}/${chat.source}`,
          to: `${params.api}/${params.source}`,
        },
        "chat: provider switched",
      );
    });
  }

  // Branch a chat at `atSeq` into a NEW chat. "Canon is the only thing that crosses" (the measured
  // fork model): copy messages seq ≤ atSeq + the config pins; the original stays intact. raw-target
  // rebuilds history from the copied canon (no session). sdk-target seeds session_entries from the
  // copied canon via the empirically-validated buildSeedFrames (./seed) so resume works.
  async function forkChat(params: ForkChatParams): Promise<{ chatId: string }> {
    const ownerId = await ensureUser(db, params.username);
    const source = await loadOwnedChat(ownerId, params.chatId);

    if (params.atSeq < 1) {
      throw new ChatOperationError("invalid_fork_point", `atSeq must be ≥ 1 (got ${params.atSeq})`);
    }

    // Append-only + seq-anchored, so this read is point-consistent without locking the source
    // (a concurrent turn only appends seq > atSeq, which this filter excludes).
    const canon = await db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, params.chatId), lte(messages.seq, params.atSeq)))
      .orderBy(asc(messages.seq));
    if (canon.length === 0) {
      throw new ChatOperationError(
        "invalid_fork_point",
        `no messages at or before seq ${params.atSeq} in chat ${params.chatId}`,
      );
    }

    const now = Date.now();
    const newChatId = newId();
    // model carries only when api+source are unchanged (same catalog); switching provider resets to
    // the target default (null → resolver default).
    const sameProvider = params.targetApi === source.api && params.targetSource === source.source;
    const model = sameProvider ? source.model : null;
    // agent-sdk target gets a fresh valid-UUID session (seeded below); openrouter target has none.
    const sessionId = params.targetApi === "agent-sdk" ? randomUUID() : null;
    await db.insert(chats).values({
      id: newChatId,
      ownerId,
      title: `${source.title} (fork)`,
      characterVersionId: source.characterVersionId, // the PIN — shared immutable version, not a copy
      personaId: source.personaId,
      presetVersionId: source.presetVersionId,
      api: params.targetApi,
      source: params.targetSource,
      model,
      sessionId,
      parentChatId: params.chatId,
      forkedAt: now,
      messageCount: canon.length,
      createdAt: now,
      updatedAt: now,
    });

    // Copy canon: new ids, new chatId, seq preserved (source seq starts at 1). Keep said-content +
    // model/provider provenance; leave per-generation token/cost metadata null (the fork didn't
    // generate these — avoids double-counting them in cross-chat analytics).
    await db.insert(messages).values(
      canon.map((m) => ({
        id: newId(),
        chatId: newChatId,
        seq: m.seq,
        role: m.role,
        content: m.content,
        model: m.model,
        provider: m.provider,
        stopReason: m.stopReason,
        createdAt: m.createdAt,
      })),
    );

    // Copy chat-level world-info attachments (chat config, like the persona/preset pins);
    // character-version WI rides along via the shared characterVersionId. (None exist yet — no
    // attach endpoint — so this is forward-correctness.)
    const wiAttach = await db
      .select()
      .from(chatWorldEntries)
      .where(eq(chatWorldEntries.chatId, params.chatId));
    if (wiAttach.length > 0) {
      await db.insert(chatWorldEntries).values(
        wiAttach.map((w) => ({
          chatId: newChatId,
          entryId: w.entryId,
          scope: w.scope,
          pinned: w.pinned,
        })),
      );
    }

    // sdk-target: seed the new chat's session from the copied canon (user/assistant only — system
    // content rides in the assembled prompt) so the next send's resume sees the branched history.
    // The frame shape is empirically validated (./seed). raw-target needs none (rebuilds from canon).
    if (sessionId !== null) {
      const seedTurns: SeedTurn[] = [];
      for (const m of canon) {
        if (m.role === "user" || m.role === "assistant") {
          seedTurns.push({ role: m.role, content: m.content, model: m.model });
        }
      }
      // projectKey is required by SessionKey but unused by DbSessionStore (it keys on sessionId).
      await new DbSessionStore(db, newChatId).append(
        { projectKey: newChatId, sessionId },
        buildSeedFrames(seedTurns, sessionId),
      );
    }

    getLog().info(
      {
        chatId: newChatId,
        parentChatId: params.chatId,
        atSeq: params.atSeq,
        copied: canon.length,
        targetApi: params.targetApi,
        targetSource: params.targetSource,
        seeded: sessionId !== null,
      },
      "chat: forked",
    );
    return { chatId: newChatId };
  }

  // Build a FRESH agent-sdk session from the chat's current canon and return its sessionId (the
  // "every turn resumes from a branch point" model — validated buildSeedFrames). Greeting-first
  // canon (assistant at seq 1, no user) gets the ST invisible-user prefix, matching create(). Does
  // NOT delete any prior session — callers that rotate handle that. Used by reseedSdkSession (after
  // a canon mutation) and setProvider (when a chat enters agent-sdk from the openrouter runner).
  async function seedSessionFromCanon(chatId: string): Promise<string> {
    const canon = await loadCanonHistory(chatId);
    const newSessionId = randomUUID();
    if (canon.length > 0) {
      const seed: SeedTurn[] =
        canon[0]?.role === "assistant"
          ? [{ role: "user", content: GREETING_USER_STUB }, ...canon]
          : canon;
      await new DbSessionStore(db, chatId).append(
        { projectKey: chatId, sessionId: newSessionId },
        buildSeedFrames(seed, newSessionId),
      );
    }
    return newSessionId;
  }

  // After any canon mutation (edit / select / swipe) on an agent-sdk chat, re-seed the session from
  // CURRENT canon so the next resume reflects it (simpler + safer than session-frame surgery, and
  // swipe/edit are infrequent so the re-cache cost is fine). Rotates sessionId and drops the OLD
  // frames (no orphans). The openrouter runner has no session → no-op (returns null). Returns the
  // new sessionId to persist on the chat (or null).
  async function reseedSdkSession(chat: typeof chats.$inferSelect): Promise<string | null> {
    if (chat.api !== "agent-sdk") {
      return null;
    }
    if (chat.sessionId !== null) {
      await db.delete(sessionEntries).where(eq(sessionEntries.sessionId, chat.sessionId));
    }
    return seedSessionFromCanon(chat.id);
  }

  async function loadOwnedMessage(
    chatId: string,
    messageId: string,
  ): Promise<typeof messages.$inferSelect> {
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.chatId, chatId)))
      .limit(1);
    const msg = rows[0];
    if (!msg) {
      throw new ChatOperationError("no_such_message", `message ${messageId} not in chat ${chatId}`);
    }
    return msg;
  }

  // Swipe: regenerate the LAST assistant turn as a new variant (it does NOT advance seq — it mutates
  // the tip). First swipe migrates the existing single generation to variant 0 (its first-gen metadata
  // stays on the messages row); the new generation is variant N and becomes active.
  async function swipe(params: SwipeParams): Promise<SendResult> {
    const ownerId = await ensureUser(db, params.username);
    return withChatLock(params.chatId, async (): Promise<SendResult> => {
      const chat = await loadOwnedChat(ownerId, params.chatId);
      const currentMax = await maxSeq(params.chatId);
      if (currentMax !== params.expectedSeq) {
        return {
          status: "stale",
          messages: await listByChat(params.chatId),
          latestSeq: currentMax,
        };
      }
      const tipRows = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, params.chatId))
        .orderBy(desc(messages.seq))
        .limit(1);
      const tip = tipRows[0];
      if (!tip || tip.role !== "assistant") {
        throw new ChatOperationError("not_swipeable", "the last message is not an assistant turn");
      }
      // The user turn we regenerate from. null → the tip is a seeded greeting (seq 1, no user) → the
      // regen uses the OPEN_SCENE prompt (same path as generateOpeningIfEmpty), producing an alt greeting.
      const userRows = await db
        .select({ seq: messages.seq, content: messages.content })
        .from(messages)
        .where(
          and(
            eq(messages.chatId, params.chatId),
            eq(messages.role, "user"),
            lt(messages.seq, tip.seq),
          ),
        )
        .orderBy(desc(messages.seq))
        .limit(1);
      const lastUser = userRows[0] ?? null;
      const regenPrompt = lastUser?.content ?? OPEN_SCENE_PROMPT;
      const history = await loadCanonHistory(params.chatId, lastUser?.seq ?? tip.seq);

      const [assembleCtx, promptConfig] = await Promise.all([
        buildAssembleContext(chat),
        resolveConfig(chat),
      ]);
      const systemPrompt = assemblePrompt(promptConfig, assembleCtx);
      const routing = resolveTurnRouting(chat, promptConfig);

      const startedAt = Date.now();
      let turn: ChatTurnResult;
      // agent-sdk pre-seeds a fresh session from the pre-user history; the regen turn completes it to
      // the new canonical state. Track it so a failed turn cleans up the seeded frames (no orphan).
      let seededSessionId: string | null = null;
      try {
        if (routing.runner === "agent-sdk") {
          const store = new DbSessionStore(db, params.chatId);
          if (history.length > 0) {
            seededSessionId = randomUUID();
            await store.append(
              { projectKey: params.chatId, sessionId: seededSessionId },
              buildSeedFrames(history, seededSessionId),
            );
            turn = await runTurn({
              prompt: regenPrompt,
              model: routing.model,
              source: routing.source,
              sessionStore: store,
              systemPrompt,
              generation: promptConfig.params,
              resume: seededSessionId,
            });
          } else {
            // greeting swipe: fresh session, OPEN_SCENE prompt generates an alternate opening.
            turn = await runTurn({
              prompt: regenPrompt,
              model: routing.model,
              source: routing.source,
              sessionStore: store,
              systemPrompt,
              generation: promptConfig.params,
            });
          }
        } else {
          turn = await openRouterRunner(routing.api)({
            model: routing.model,
            systemPrompt,
            history: [...history, { role: "user", content: regenPrompt }],
            generation: promptConfig.params,
            providerRouting: routing.providerRouting,
          });
        }
      } catch (error) {
        if (seededSessionId !== null) {
          await db.delete(sessionEntries).where(eq(sessionEntries.sessionId, seededSessionId));
        }
        if (error instanceof TurnError) {
          getLog().warn(
            { chatId: params.chatId, kind: error.kind },
            "chat: swipe generation failed (no change)",
          );
          return {
            status: "error",
            code: error.kind,
            retryable: error.retryable,
            ...(error.resetsAt !== undefined ? { resetsAt: error.resetsAt } : {}),
            messages: await listByChat(params.chatId),
          };
        }
        throw error;
      }

      // Persist the new variant. First swipe backfills variant 0 from the current single generation.
      const existing = await db
        .select({ idx: messageVariants.idx })
        .from(messageVariants)
        .where(eq(messageVariants.messageId, tip.id));
      const now = Date.now();
      let nextIdx = 0;
      if (existing.length === 0) {
        // Preserve the first generation's provenance in variant 0 (incl. its tokens) before the
        // message row gets repointed to the new variant below — else variant 0's per-variant token
        // counts would be lost (the message row's columns are about to change).
        await db.insert(messageVariants).values({
          id: newId(),
          messageId: tip.id,
          idx: 0,
          content: tip.content,
          model: tip.model,
          provider: tip.provider,
          tokensIn: tip.tokensIn,
          tokensOut: tip.tokensOut,
          createdAt: tip.createdAt,
        });
        nextIdx = 1;
      } else {
        nextIdx = Math.max(...existing.map((v) => v.idx)) + 1;
      }
      await db.insert(messageVariants).values({
        id: newId(),
        messageId: tip.id,
        idx: nextIdx,
        content: turn.reply,
        model: turn.usage.model,
        provider: `${routing.api}/${routing.source}`,
        reasoningEffort: promptConfig.params.effort ?? null,
        tokensIn: turn.usage.tokensIn,
        tokensOut: turn.usage.tokensOut,
        genStarted: startedAt,
        genFinished: now,
        createdAt: now,
      });
      // The message row tracks the ACTIVE variant in BOTH content and provenance — so its token/
      // cost/context columns describe what's rendered, not a buried first gen. (The full per-gen
      // record lives in message_variants; the richer fields here = the latest generation.)
      await db
        .update(messages)
        .set({
          activeVariantIdx: nextIdx,
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
        })
        .where(eq(messages.id, tip.id));
      await recordTurnEvents(params.chatId, tip.id, turn.events);

      // agent-sdk: the regen session (seeded → completed, or the fresh greeting session) is now
      // canonical. Drop the pre-swipe session's frames and point the chat at the new one. The
      // openrouter runner has no session.
      // A swipe is a real generation — its tokens count toward the chat totals (else regenerations
      // silently undercount cost/allowance). messageCount is unchanged (the swipe mutates the tip).
      const tokenTotals = {
        totalTokensIn: (chat.totalTokensIn ?? 0) + turn.usage.tokensIn,
        totalTokensOut: (chat.totalTokensOut ?? 0) + turn.usage.tokensOut,
      };
      if (routing.runner === "agent-sdk") {
        if (chat.sessionId !== null && chat.sessionId !== turn.sessionId) {
          await db.delete(sessionEntries).where(eq(sessionEntries.sessionId, chat.sessionId));
        }
        await db
          .update(chats)
          .set({ sessionId: turn.sessionId || chat.sessionId, ...tokenTotals, updatedAt: now })
          .where(eq(chats.id, params.chatId));
      } else {
        await db
          .update(chats)
          .set({ ...tokenTotals, updatedAt: now })
          .where(eq(chats.id, params.chatId));
      }

      getLog().info(
        {
          chatId: params.chatId,
          messageId: tip.id,
          newVariantIdx: nextIdx,
          api: routing.api,
          source: routing.source,
        },
        "chat: swiped (new variant)",
      );
      return { status: "ok", messages: await listByChat(params.chatId) };
    });
  }

  // Make an existing variant active (swipe ← →). No model call; just repoints + re-seeds the session.
  async function selectVariant(params: SelectVariantParams): Promise<MessageView[]> {
    const ownerId = await ensureUser(db, params.username);
    return withChatLock(params.chatId, async () => {
      const chat = await loadOwnedChat(ownerId, params.chatId);
      await loadOwnedMessage(params.chatId, params.messageId); // ownership + existence
      const vRows = await db
        .select({
          content: messageVariants.content,
          model: messageVariants.model,
          provider: messageVariants.provider,
          tokensIn: messageVariants.tokensIn,
          tokensOut: messageVariants.tokensOut,
        })
        .from(messageVariants)
        .where(
          and(
            eq(messageVariants.messageId, params.messageId),
            eq(messageVariants.idx, params.variantIdx),
          ),
        )
        .limit(1);
      const variant = vRows[0];
      if (!variant) {
        throw new ChatOperationError(
          "no_such_variant",
          `variant ${params.variantIdx} not found on message ${params.messageId}`,
        );
      }
      // Keep the message row's per-variant provenance (tokens/model/provider) consistent with the
      // selected variant's content. (The richer columns — cost/context/cache/ttft — aren't stored
      // per variant, so they continue to reflect the latest generation; full per-variant provenance
      // is a future migration.)
      await db
        .update(messages)
        .set({
          activeVariantIdx: params.variantIdx,
          content: variant.content,
          model: variant.model,
          provider: variant.provider,
          tokensIn: variant.tokensIn,
          tokensOut: variant.tokensOut,
        })
        .where(eq(messages.id, params.messageId));
      const newSessionId = await reseedSdkSession(chat);
      if (newSessionId !== null) {
        await db
          .update(chats)
          .set({ sessionId: newSessionId, updatedAt: Date.now() })
          .where(eq(chats.id, params.chatId));
      }
      return listByChat(params.chatId);
    });
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

  // Manually compact an agent-sdk chat's session via a steered `/compact` turn (the lever for
  // compaction mode "off"). No-op for openrouter (stateless — nothing to compact) or a chat with no
  // session yet. /compact compacts the transcript without generating a reply; we keep canon (the
  // messages) untouched and just repoint the session + record the compaction event.
  async function compact(params: CompactParams): Promise<{ compacted: boolean }> {
    const ownerId = await ensureUser(db, params.username);
    return withChatLock(params.chatId, async () => {
      const chat = await loadOwnedChat(ownerId, params.chatId);
      if (chat.api !== "agent-sdk" || chat.sessionId === null) {
        return { compacted: false };
      }
      const [assembleCtx, promptConfig] = await Promise.all([
        buildAssembleContext(chat),
        resolveConfig(chat),
      ]);
      const routing = resolveTurnRouting(chat, promptConfig);
      if (routing.runner !== "agent-sdk") {
        return { compacted: false };
      }
      const instructions =
        params.instructions ??
        promptConfig.params.compaction?.instructions ??
        DEFAULT_COMPACT_INSTRUCTIONS;
      try {
        const turn = await runTurn({
          prompt: `/compact ${instructions}`,
          model: routing.model,
          source: routing.source,
          sessionStore: new DbSessionStore(db, params.chatId),
          systemPrompt: assemblePrompt(promptConfig, assembleCtx),
          generation: promptConfig.params,
          resume: chat.sessionId,
        });
        await db
          .update(chats)
          .set({ sessionId: turn.sessionId || chat.sessionId, updatedAt: Date.now() })
          .where(eq(chats.id, params.chatId));
        await recordTurnEvents(params.chatId, null, turn.events);
        getLog().info(
          { chatId: params.chatId, events: turn.events.length },
          "chat: compacted (manual)",
        );
        return { compacted: true };
      } catch (error) {
        if (error instanceof TurnError) {
          getLog().warn(
            { chatId: params.chatId, kind: error.kind },
            "chat: manual compaction failed",
          );
          return { compacted: false };
        }
        throw error;
      }
    });
  }

  return {
    create,
    listChats,
    getChat,
    previewAssembly,
    listMessages,
    send,
    setProvider,
    forkChat,
    swipe,
    selectVariant,
    editMessage,
    compact,
  };
}
