import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import {
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
import type {
  AssembleContext,
  AssemblePersona,
  AssembleWorldEntry,
} from "../../../shared/prompt-assemble";
import {
  DEFAULT_PROMPT_CONFIG,
  type PromptConfig,
  parsePromptConfig,
  type WorldInfoScope,
} from "../../../shared/prompt-config";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { createReranker, type Reranker } from "../../embeddings/reranker";
import { runChatTurn } from "../../providers/claude-sdk";
import { runChatCompletionTurn, runRawTurn } from "../../providers/openrouter";
import type { TurnEvent } from "../../providers/turn";
import { newId } from "../_shared/ids";
import { retrieveMemory } from "./memory";
import { buildSeedFrames, GREETING_USER_STUB, type SeedTurn } from "./seed";
import { DbSessionStore } from "./store";
import { ChatNotFoundError, ChatOperationError, type MessageView } from "./types";

// Both runners are injectable so the turn logic is testable with fakes (no sub queries / no
// network in `pnpm check`); production uses the real adapters. Which one runs is decided per
// turn by resolveTurnRouting (./routing), the single owner of model + provider selection.
export interface ChatServiceDeps {
  runTurn?: typeof runChatTurn;
  runRaw?: typeof runRawTurn;
  runChatCompletion?: typeof runChatCompletionTurn;
  // Embedding stack for the {{memory}} marker (chat-history RAG). Injectable so memory retrieval is
  // testable with a fake embedder (no model/GPU in `pnpm check`). Defaults = the real in-process
  // BGE-M3 + cross-encoder (lazy singletons — never loaded unless a chat actually uses memory).
  embedder?: Embedder;
  reranker?: Reranker;
}

// Recent message texts the keyword-WI marker scans. Small + tunable; includes the just-inserted
// user message (send inserts it before assembling), which is what should trigger keyword WI.
const RECENT_MESSAGE_WINDOW = 6;

// A session-frame message.content is a string OR an array of content blocks — flatten to text.
function frameContentToText(content: unknown): string {
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

/**
 * The shared substrate every chat verb (send / swipe / fork / compaction / …) closes over: the
 * Db handle, the resolved + injectable turn runners and embedding stack, and the read / load /
 * assemble / seed helpers the verbs all call. Built once per `createChatService`; the verb factory
 * modules receive the returned object and destructure what they need. This is the closure scope
 * that used to be implicit inside one giant factory, now made explicit so it can span files.
 */
export function createChatContext(db: Db, deps: ChatServiceDeps = {}) {
  const runTurn = deps.runTurn ?? runChatTurn;
  const runRaw = deps.runRaw ?? runRawTurn;
  const runChatCompletion = deps.runChatCompletion ?? runChatCompletionTurn;
  const embedder = deps.embedder ?? createEmbedder();
  const reranker = deps.reranker ?? createReranker();

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

  // After a /compact, the SDK writes the summary as a synthetic `user` frame in the session store
  // ("This session is being continued from a previous conversation… Summary: …"). Recover that text
  // so it becomes our portable artifact. Best-effort + defensive about the frame shape — a format
  // change just yields null (caller degrades to full canon). Scans the few most-recent user frames.
  async function extractCompactSummary(sessionId: string): Promise<string | null> {
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

    // {{user}} resolves against the ACTIVE persona (chats.personaId) for user-authored sections and
    // the PINNED persona (chats.pinnedPersonaId, captured at open) for card-derived ones — so
    // switching who you play mid-chat never rewrites the card's {{user}}. pinnedPersonaId null →
    // falls back to the active persona (chats opened before the column / no persona at open).
    const loadPersona = async (id: string | null): Promise<AssemblePersona | null> => {
      if (id === null) return null;
      const rows = await db
        .select({ name: personas.name, description: personas.description })
        .from(personas)
        .where(eq(personas.id, id))
        .limit(1);
      return rows[0] ?? null;
    };
    const activePersona = await loadPersona(chat.personaId);
    const pinnedPersona =
      chat.pinnedPersonaId === null ? activePersona : await loadPersona(chat.pinnedPersonaId);

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

    // Memory ({{memory}} marker): chat-history RAG, opt-in via GenerationParams.memory.enabled AND
    // an enabled memory marker in the config (no marker ⇒ retrieval would render nowhere, so skip
    // the work). resolveConfig is a cheap re-resolve (the caller resolves it again in parallel).
    let memory: string | null = null;
    const config = await resolveConfig(chat);
    const memCfg = config.params.memory;
    const hasMemoryMarker = config.sections.some(
      (s) => s.type === "marker" && s.marker === "memory" && s.enabled,
    );
    if (memCfg?.enabled === true && hasMemoryMarker) {
      memory = await retrieveMemory(
        db,
        { embedder, reranker },
        {
          chatId: chat.id,
          params: memCfg,
          charName: cv?.name ?? "Assistant",
          userName: activePersona?.name ?? "User",
        },
      );
    }

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
      pinnedPersona,
      activePersona,
      worldEntries: [
        ...chatWi.map((r) => toWorldEntry(r, "chat")),
        ...cvWi.map((r) => toWorldEntry(r, "character")),
      ],
      recentMessages: recent.map((r) => r.content).reverse(),
      // Only the STATELESS openrouter runner injects the summary (the agent-sdk session carries
      // compaction natively — injecting it there would double up). So agent-sdk chats see null.
      compactSummary: chat.api === "agent-sdk" ? null : chat.compactSummary,
      memory,
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

  // Raw-mode rebuilds the conversation from canon every turn (no SDK session). user/assistant
  // turns only — system content is carried by the assembled `instructions`, not `input`.
  //  • beforeSeq → seq < beforeSeq (a swipe regenerates from the history BEFORE the user msg).
  //  • afterSeq → seq > afterSeq (compaction pickup: the {{compact_summary}} marker stands in for
  //    everything ≤ the compaction anchor, so we only resend the turns after it).
  async function loadCanonHistory(
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

  return {
    db,
    runTurn,
    openRouterRunner,
    loadOwnedChat,
    loadOwnedMessage,
    listByChat,
    loadCanonHistory,
    maxSeq,
    recordTurnEvents,
    buildAssembleContext,
    resolveConfig,
    seedSessionFromCanon,
    reseedSdkSession,
    extractCompactSummary,
  };
}

/** The shared substrate object the verb factories receive (inferred from `createChatContext`). */
export type ChatContext = ReturnType<typeof createChatContext>;
