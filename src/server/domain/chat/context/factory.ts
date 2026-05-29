import type { Db } from "../../../../db/client";
import type { chats } from "../../../../db/schema";
import { createSecretBox, credentialsKeyFromEnv } from "../../../crypto/secrets";
import { createEmbedder } from "../../../embeddings/embedder";
import { createReranker } from "../../../embeddings/reranker";
import { createSummarizer } from "../../../embeddings/summarizer";
import { runChatTurn } from "../../../providers/claude-sdk";
import { runChatCompletionTurn, runRawTurn } from "../../../providers/openrouter";
import type { TurnEvent } from "../../../providers/turn";
import { resolveCredential } from "../../_shared/credentials";
import { retrieveMemory } from "../memory/retrieve";
import type { MemoryConfig } from "../memory/types";
import { buildAssembleContext, resolveConfig } from "./assemble";
import {
  extractCompactSummary,
  listByChat,
  loadCanonHistory,
  loadOwnedChat,
  loadOwnedMessage,
  maxSeq,
  recordTurnEvents,
} from "./queries";
import { reseedSdkSession, seedSessionFromCanon } from "./session";
import type { ChatServiceDeps } from "./types";

export function createChatContext(db: Db, deps: ChatServiceDeps = {}) {
  const runTurn = deps.runTurn ?? runChatTurn;
  const runRaw = deps.runRaw ?? runRawTurn;
  const runChatCompletion = deps.runChatCompletion ?? runChatCompletionTurn;
  const embedder = deps.embedder ?? createEmbedder();
  const reranker = deps.reranker ?? createReranker();
  const summarizer = deps.summarizer ?? createSummarizer();
  // The credential encryption box (env-backed by default); the turn-time resolver decrypts BYO keys
  // through it. Injected so tests can supply a known key.
  const secretBox = deps.secretBox ?? createSecretBox(credentialsKeyFromEnv());

  function openRouterRunner(api: "chat-completions" | "responses"): typeof runRawTurn {
    return api === "chat-completions" ? runChatCompletion : runRaw;
  }

  return {
    db,
    embedder,
    summarizer,
    runTurn,
    openRouterRunner,
    // The single turn-time credential chokepoint (§8): gates max-pro-sub to admins, resolves the
    // per-user (or host-fallback) OpenRouter key. Verbs call this before running a turn.
    resolveCredential: (ownerId: string, source: "max-pro-sub" | "openrouter") =>
      resolveCredential(db, secretBox, ownerId, source),
    loadOwnedChat: (ownerId: string, chatId: string) => loadOwnedChat(db, ownerId, chatId),
    loadOwnedMessage: (chatId: string, messageId: string) =>
      loadOwnedMessage(db, chatId, messageId),
    listByChat: (chatId: string) => listByChat(db, chatId),
    loadCanonHistory: (
      chatId: string,
      bounds?: { beforeSeq?: number | undefined; afterSeq?: number | undefined },
    ) => loadCanonHistory(db, chatId, bounds),
    maxSeq: (chatId: string) => maxSeq(db, chatId),
    recordTurnEvents: (chatId: string, messageId: string | null, events: TurnEvent[]) =>
      recordTurnEvents(db, chatId, messageId, events),
    buildAssembleContext: (chat: typeof chats.$inferSelect, opts?: { deferMemory?: boolean }) =>
      buildAssembleContext(db, embedder, reranker, chat, opts),
    // Memory retrieval, exposed so `send` can run it with the in-flight (regex-processed) user turn,
    // AFTER that turn is known — the query then reflects the message being answered.
    retrieveMemory: (chatId: string, params: MemoryConfig, pendingUserText: string) =>
      retrieveMemory(db, { embedder, reranker }, { chatId, params, pendingUserText }),
    resolveConfig: (chat: typeof chats.$inferSelect) => resolveConfig(db, chat),
    seedSessionFromCanon: (chatId: string) => seedSessionFromCanon(db, chatId),
    reseedSdkSession: (chat: typeof chats.$inferSelect) => reseedSdkSession(db, chat),
    extractCompactSummary: (sessionId: string) => extractCompactSummary(db, sessionId),
  };
}

export type ChatContext = ReturnType<typeof createChatContext>;
