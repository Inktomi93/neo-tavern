import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  characters,
  characterVersions,
  chats,
  messages,
  messageVariants,
  personas,
  presets,
} from "../../../db/schema";
import { assemblePrompt } from "../../../shared/prompt-assemble";
import { getLog } from "../../observability/logger";
import { TurnError } from "../../providers/turn";
import { DomainNotFoundError, DomainOperationError } from "../_shared/errors";
import { newId } from "../_shared/ids";
import { withChatLock } from "../_shared/lock";
import { loadUserSettings } from "../_shared/user-settings";
import { ensureUser } from "../_shared/users";
import { OPEN_SCENE_PROMPT } from "./constants";
import type { ChatContext } from "./context/factory";
import { buildTurnProvenance } from "./helpers";
import { resolveTurnRouting } from "./routing";
import { buildSeedFrames, GREETING_USER_STUB } from "./seed";
import { DbSessionStore } from "./store";
import type {
  EditMessageParams,
  MessageView,
  SendParams,
  SendResult,
  StartChatParams,
  StartChatResult,
} from "./types";

/**
 * Lifecycle ops: `startChat` (LAZY creation — scaffold an existing character version into a chat,
 * seed defaults from user settings, then run the FIRST turn), the internal `generateOpening` helper
 * (the model writes the opening; any provider), and `editMessage` (in-place edit + sdk re-seed).
 * `send` is injected (the one verb-to-verb dependency, like send→runCompaction) so the first turn
 * reuses the entire send pipeline rather than duplicating it.
 */
export function createLifecycle(
  ctx: ChatContext,
  ops: { send: (params: SendParams) => Promise<SendResult> },
) {
  const { db, loadOwnedChat, loadOwnedMessage, listByChat, runTurn, recordTurnEvents } = ctx;
  const { buildAssembleContext, resolveConfig, reseedSdkSession, openRouterRunner } = ctx;
  const { resolveCredential } = ctx;
  const { send } = ops;

  // Resolve an EXISTING, owned character version (chat-start references the library, never creates a
  // character inline — the `character` domain owns that). Returns name + greetings for opening.
  async function loadOwnedVersion(
    ownerId: string,
    characterVersionId: string,
  ): Promise<{ name: string; greetings: string[] }> {
    const rows = await db
      .select({
        name: characterVersions.name,
        greetings: characterVersions.greetings,
        ownerId: characters.ownerId,
      })
      .from(characterVersions)
      .innerJoin(characters, eq(characters.id, characterVersions.characterId))
      .where(eq(characterVersions.id, characterVersionId))
      .limit(1);
    const v = rows[0];
    if (!v || v.ownerId !== ownerId) {
      throw new DomainNotFoundError("character version", characterVersionId);
    }
    const greetings = Array.isArray(v.greetings)
      ? v.greetings.filter((g): g is string => typeof g === "string")
      : [];
    return { name: v.name, greetings };
  }

  // Seed defaults are LENIENT at consumption: a stale/unowned preset or persona id degrades to null
  // (→ the system default prompt / no persona) rather than failing chat creation.
  async function resolveOwnedPresetVersion(
    ownerId: string,
    presetId: string | null,
  ): Promise<string | null> {
    if (!presetId) return null;
    const rows = await db
      .select({ currentVersionId: presets.currentVersionId, ownerId: presets.ownerId })
      .from(presets)
      .where(eq(presets.id, presetId))
      .limit(1);
    const p = rows[0];
    return p && p.ownerId === ownerId ? (p.currentVersionId ?? null) : null;
  }

  async function resolveOwnedPersona(
    ownerId: string,
    personaId: string | null,
  ): Promise<string | null> {
    if (!personaId) return null;
    const rows = await db
      .select({ ownerId: personas.ownerId })
      .from(personas)
      .where(eq(personas.id, personaId))
      .limit(1);
    return rows[0]?.ownerId === ownerId ? personaId : null;
  }

  // Write the greeting as seq 1. For agent-sdk, also seed the SDK session (so the first turn's resume
  // sees it) via the ST invisible-user stub → the validated user→assistant seed shape. For openrouter
  // there is NO session (it rebuilds from canon every turn), so just record the message.
  async function seedGreeting(
    chatId: string,
    greeting: string,
    api: "agent-sdk" | "chat-completions" | "responses",
    now: number,
  ): Promise<void> {
    await db.insert(messages).values({
      id: newId(),
      chatId,
      seq: 1,
      role: "assistant",
      content: greeting,
      createdAt: now,
    });
    if (api === "agent-sdk") {
      const sessionId = randomUUID();
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
    } else {
      await db.update(chats).set({ messageCount: 1 }).where(eq(chats.id, chatId));
    }
  }

  // Lazy creation + commit. Scaffolds the chat row (resolved + seeded routing/preset/persona), writes
  // the greeting (user-message path only), then runs the FIRST turn — the user's message (delegated to
  // the full `send` pipeline) or a generated opening. A chat row exists only after this is called.
  async function startChat(params: StartChatParams): Promise<StartChatResult> {
    const ownerId = await ensureUser(db, params.username);

    // Exactly one commit trigger. A greeting-only / blank chat is a CLIENT draft and never reaches here.
    const userMessage = params.firstUserMessage?.trim() ?? "";
    const hasUserMessage = userMessage.length > 0;
    const wantsOpening = params.generateOpening === true;
    if (hasUserMessage === wantsOpening) {
      throw new DomainOperationError(
        "invalid_commit_trigger",
        "startChat requires exactly one of firstUserMessage or generateOpening.",
      );
    }

    const version = await loadOwnedVersion(ownerId, params.characterVersionId);
    const settings = await loadUserSettings(db, ownerId);

    // Seed routing: caller arg → user default → schema default (undefined ⇒ the column default applies).
    const api = params.api ?? settings.defaultApi;
    const source = params.source ?? settings.defaultSource;
    const model = params.model ?? settings.defaultModel ?? null;

    // Turn-time credential gate (§8), run BEFORE the chat row is created so a denied credential
    // (a non-owner defaulting into max-pro-sub; no OpenRouter key) leaves NO empty chat behind. This
    // is the resolver — the single chokepoint — replacing the old owner-handle guard. The first turn
    // (send / generateOpening) re-resolves to get the actual key (idempotent + cheap).
    await resolveCredential(ownerId, source ?? "max-pro-sub");

    const presetVersionId = await resolveOwnedPresetVersion(
      ownerId,
      params.presetId ?? settings.defaultPresetId ?? null,
    );
    const personaId = await resolveOwnedPersona(
      ownerId,
      params.personaId ?? settings.defaultPersonaId ?? null,
    );

    const chatId = params.chatId ?? newId();
    const now = Date.now();
    const title = (params.title ?? version.name).trim() || version.name;

    await db.insert(chats).values({
      id: chatId,
      ownerId,
      title,
      characterVersionId: params.characterVersionId,
      personaId,
      // The persona pinned at open (what the card's {{user}} resolves against) = the active persona.
      pinnedPersonaId: personaId,
      presetVersionId,
      // undefined keys fall through to the schema column defaults (api=agent-sdk, source=max-pro-sub).
      ...(api !== undefined ? { api } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(model !== null ? { model } : {}),
      createdAt: now,
      updatedAt: now,
    });

    if (hasUserMessage) {
      // Greeting (if the chosen index exists) becomes seq 1; the user's message follows via send.
      let expectedSeq = 0;
      const idx = params.greetingIndex ?? 0;
      const greeting = (version.greetings[idx] ?? "").trim();
      if (greeting.length > 0) {
        await seedGreeting(chatId, greeting, api ?? "agent-sdk", now);
        expectedSeq = 1;
      }
      // Delegate the first turn to the full send pipeline (regex, routing, provider, provenance,
      // compaction, indexing, error rollback) — no duplication; send stays the single turn path.
      const result = await send({
        username: params.username,
        chatId,
        expectedSeq,
        content: userMessage,
        timezone: params.timezone,
      });
      return { chatId, result };
    }

    // generateOpening: the model writes seq 1; no greeting, no user message.
    await generateOpening(ownerId, chatId, params.timezone);
    return { chatId, result: { status: "ok", messages: await listByChat(chatId) } };
  }

  // The model writes the opening message in-character via a no-user-message turn — a hidden open-scene
  // prompt (never a messages row) elicits it. Runs on ANY provider: agent-sdk builds the session;
  // openrouter rebuilds statelessly (the prompt rides as a single user turn). Graceful: a provider
  // failure leaves the chat blank (the user can just speak first) rather than failing creation.
  async function generateOpening(
    ownerId: string,
    chatId: string,
    timezone?: string,
  ): Promise<void> {
    const chat = await loadOwnedChat(ownerId, chatId);
    const [assembleCtx, promptConfig] = await Promise.all([
      buildAssembleContext(chat, { timezone }),
      resolveConfig(chat),
    ]);
    const routing = resolveTurnRouting(chat, promptConfig);
    const credential = await resolveCredential(ownerId, routing.source);
    const openRouterApiKey =
      credential.source === "openrouter" ? credential.openRouterKey : undefined;
    const systemPrompt = assemblePrompt(promptConfig, assembleCtx);
    try {
      const turn =
        routing.runner === "agent-sdk"
          ? await runTurn({
              prompt: OPEN_SCENE_PROMPT,
              model: routing.model,
              source: routing.source,
              openRouterApiKey,
              sessionStore: new DbSessionStore(db, chatId),
              systemPrompt,
              generation: promptConfig.params,
            })
          : await openRouterRunner(routing.api)({
              model: routing.model,
              openRouterApiKey: openRouterApiKey ?? "", // openrouter runner ⟹ openrouter credential
              chatId,
              systemPrompt,
              history: [{ role: "user", content: OPEN_SCENE_PROMPT }],
              generation: routing.params,
              providerRouting: routing.providerRouting,
            });
      const openingMsgId = newId();
      await db.insert(messages).values({
        id: openingMsgId,
        chatId,
        seq: 1,
        role: "assistant",
        ...buildTurnProvenance(
          turn,
          `${routing.api}/${routing.source}`,
          promptConfig.params.effort,
        ),
        createdAt: Date.now(),
      });
      await recordTurnEvents(chatId, openingMsgId, turn.events);
      await db
        .update(chats)
        .set({
          // sessionId is an agent-sdk concept; the openrouter runner has none (rebuilds from canon).
          ...(routing.runner === "agent-sdk" ? { sessionId: turn.sessionId } : {}),
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

  // Shared skeleton for simple single-field chat updates: resolve owner → lock → verify ownership
  // → update. All three public mutators below are just a field name + value away from each other.
  async function patchChat(
    username: string,
    chatId: string,
    patch: Partial<typeof chats.$inferInsert>,
  ): Promise<void> {
    const ownerId = await ensureUser(db, username);
    return withChatLock(chatId, async () => {
      await loadOwnedChat(ownerId, chatId);
      await db
        .update(chats)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(chats.id, chatId));
    });
  }

  async function updateTitle(params: {
    username: string;
    chatId: string;
    title: string;
  }): Promise<void> {
    return patchChat(params.username, params.chatId, { title: params.title });
  }

  async function star(params: {
    username: string;
    chatId: string;
    starred: boolean;
  }): Promise<void> {
    return patchChat(params.username, params.chatId, { starred: params.starred });
  }

  async function archive(params: {
    username: string;
    chatId: string;
    archived: boolean;
  }): Promise<void> {
    return patchChat(params.username, params.chatId, { archived: params.archived });
  }

  return { startChat, editMessage, delete: deleteChat, updateTitle, star, archive };
}
