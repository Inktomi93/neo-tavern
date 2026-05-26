import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Db } from "../../../db/client";
import {
  characters,
  characterVersions,
  characterVersionWorldEntries,
  chats,
  chatWorldEntries,
  messages,
  personas,
  presetVersions,
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
import { type RawTurnParams, runRawTurn } from "../../providers/openrouter";
import { type ChatTurnResult, TurnError } from "../../providers/turn";
import { newId } from "../_shared/ids";
import { withChatLock } from "../_shared/lock";
import { ensureUser } from "../_shared/users";
import { resolveTurnRouting } from "./routing";
import { buildSeedFrames, GREETING_USER_STUB, type SeedTurn } from "./seed";
import { DbSessionStore } from "./store";
import {
  ChatNotFoundError,
  ChatOperationError,
  type ChatService,
  type CreateChatParams,
  type ForkChatParams,
  type MessageView,
  type SendParams,
  type SendResult,
} from "./types";

// Both runners are injectable so the turn logic is testable with fakes (no sub queries / no
// network in `pnpm check`); production uses the real adapters. Which one runs is decided per
// turn by resolveTurnRouting (./routing), the single owner of model + provider selection.
export interface ChatServiceDeps {
  runTurn?: typeof runChatTurn;
  runRaw?: typeof runRawTurn;
}

// Recent message texts the keyword-WI marker scans. Small + tunable; includes the just-inserted
// user message (send inserts it before assembling), which is what should trigger keyword WI.
const RECENT_MESSAGE_WINDOW = 6;

// The hidden "user" turn that elicits a generated opening (generateOpeningIfEmpty). Never stored as
// a messages row — it only prompts the model to write the character's first message.
const OPEN_SCENE_PROMPT =
  "[Open the scene: write your first message to me, in character — set the scene and greet me as your character would. Stay fully in character.]";

export function createChatService(db: Db, deps: ChatServiceDeps = {}): ChatService {
  const runTurn = deps.runTurn ?? runChatTurn;
  const runRaw = deps.runRaw ?? runRawTurn;

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
      mode: "sdk",
      provider: "anthropic-sdk",
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
    if (routing.mode !== "sdk") {
      return; // create() only makes sdk chats; a raw opening would route through runRaw (not wired)
    }
    try {
      const turn = await runTurn({
        prompt: OPEN_SCENE_PROMPT,
        model: routing.model,
        sessionStore: new DbSessionStore(db, chatId),
        systemPrompt: assemblePrompt(promptConfig, assembleCtx),
      });
      await db.insert(messages).values({
        id: newId(),
        chatId,
        seq: 1,
        role: "assistant",
        content: turn.reply,
        model: turn.usage.model,
        provider: routing.provider,
        stopReason: turn.stopReason,
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
  // turns only — system content is carried by the assembled `instructions`, not `input`.
  async function loadCanonHistory(
    chatId: string,
  ): Promise<{ role: "user" | "assistant"; content: string }[]> {
    const rows = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.chatId, chatId))
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
            mode: chat.mode,
            provider: chat.provider,
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
          mode: routing.mode,
          provider: routing.provider,
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
        if (routing.mode === "sdk") {
          // sdk-mode: stateless resume-per-message through our DB-backed SessionStore.
          turn = await runTurn({
            prompt: params.content,
            model: routing.model,
            sessionStore: new DbSessionStore(db, params.chatId),
            systemPrompt,
            ...(chat.sessionId ? { resume: chat.sessionId } : {}),
          });
        } else {
          // raw-mode: rebuild the conversation from canon (incl. the user message just inserted)
          // → OpenRouter Responses turn. No session store; provider routing rides through.
          const rawParams: RawTurnParams["params"] = {
            ...(routing.params.temperature !== undefined
              ? { temperature: routing.params.temperature }
              : {}),
            ...(routing.params.maxOutputTokens !== undefined
              ? { maxOutputTokens: routing.params.maxOutputTokens }
              : {}),
          };
          turn = await runRaw({
            model: routing.model,
            systemPrompt,
            history: await loadCanonHistory(params.chatId),
            params: rawParams,
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

      await db.insert(messages).values({
        id: newId(),
        chatId: params.chatId,
        seq: userSeq + 1,
        role: "assistant",
        content: turn.reply,
        model: turn.usage.model,
        provider: routing.provider,
        stopReason: turn.stopReason,
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

      await db
        .update(chats)
        .set({
          // sessionId is an sdk-mode concept (the resume handle); raw-mode has none, so don't
          // touch it there (avoid leaning on runRaw returning a falsy sessionId).
          ...(routing.mode === "sdk" ? { sessionId: turn.sessionId || chat.sessionId } : {}),
          messageCount: (chat.messageCount ?? 0) + 2,
          totalTokensIn: (chat.totalTokensIn ?? 0) + turn.usage.tokensIn,
          totalTokensOut: (chat.totalTokensOut ?? 0) + turn.usage.tokensOut,
          updatedAt: Date.now(),
        })
        .where(eq(chats.id, params.chatId));

      // chatId-scoped turn summary (the provider already logs each event at its own level;
      // this adds the chat context + the context-fill signal the UI will show).
      getLog().debug(
        {
          chatId: params.chatId,
          seq: userSeq + 1,
          tokensIn: turn.usage.tokensIn,
          contextWindow: turn.usage.contextWindow,
          compactions: turn.events.filter((event) => event.kind === "compaction").length,
          rateLimit: turn.rateLimit?.status,
        },
        "chat turn complete",
      );
      return { status: "ok", messages: await listByChat(params.chatId) };
    });
  }

  // One-way sdk→raw conversion in place (the CLAUDE.md escape valve). The canon stays; raw-mode
  // rebuilds history from it each turn, so no session seeding is needed. Locked against in-flight
  // sends (same per-chat lock) so we never flip mode mid-turn.
  async function convertToRaw(params: { username: string; chatId: string }): Promise<void> {
    const ownerId = await ensureUser(db, params.username);
    await withChatLock(params.chatId, async () => {
      const chat = await loadOwnedChat(ownerId, params.chatId);
      if (chat.mode !== "sdk") {
        throw new ChatOperationError(
          "not_sdk",
          `chat ${params.chatId} is mode=${chat.mode}; conversion is one-way sdk→raw`,
        );
      }
      await db
        .update(chats)
        .set({
          mode: "raw",
          provider: "openrouter",
          // The sdk Claude id isn't an OpenRouter id → null so resolveTurnRouting falls back to
          // DEFAULT_RAW_MODEL_ID (the user picks a real raw model via the picker later).
          model: null,
          sessionId: null, // the sdk session no longer applies; raw rebuilds from canon
          convertedAt: Date.now(),
          updatedAt: Date.now(),
        })
        .where(eq(chats.id, params.chatId));
      getLog().info({ chatId: params.chatId, from: "sdk", to: "raw" }, "chat: converted to raw");
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
    // model carries only when the mode is unchanged (same catalog); a mode switch resets to the
    // target default (null → resolver default).
    const model = params.targetMode === source.mode ? source.model : null;
    // sdk-target gets a fresh valid-UUID session (seeded below); raw-target has none.
    const sessionId = params.targetMode === "sdk" ? randomUUID() : null;
    await db.insert(chats).values({
      id: newChatId,
      ownerId,
      title: `${source.title} (fork)`,
      characterVersionId: source.characterVersionId, // the PIN — shared immutable version, not a copy
      personaId: source.personaId,
      presetVersionId: source.presetVersionId,
      mode: params.targetMode,
      provider: params.targetMode === "sdk" ? "anthropic-sdk" : "openrouter",
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
        targetMode: params.targetMode,
        seeded: sessionId !== null,
      },
      "chat: forked",
    );
    return { chatId: newChatId };
  }

  return { create, listMessages, send, convertToRaw, forkChat };
}
