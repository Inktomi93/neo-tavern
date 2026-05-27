import { and, eq } from "drizzle-orm";
import { chats, messages } from "../../../db/schema";
import { assemblePrompt } from "../../../shared/prompt-assemble";
import { getLog } from "../../observability/logger";
import { type ChatTurnResult, TurnError } from "../../providers/turn";
import { newId } from "../_shared/ids";
import { withChatLock } from "../_shared/lock";
import { ensureUser } from "../_shared/users";
import type { RunCompaction } from "./compaction";
import { DEFAULT_COMPACT_INSTRUCTIONS, MANAGED_COMPACT_DEFAULT_PCT } from "./constants";
import type { ChatContext } from "./context";
import { generateDigests } from "./memory";
import { resolveTurnRouting } from "./routing";
import { DbSessionStore } from "./store";
import type { SendParams, SendResult } from "./types";

/**
 * The `send` op: insert the user turn, assemble the prompt, route, run the turn (agent-sdk resume
 * or stateless openrouter rebuild), persist the assistant turn + provenance, and fire managed
 * compaction. Receives `runCompaction` explicitly (from the compaction module, wired at the
 * composition root) — the one verb-to-verb dependency, kept visible rather than hidden in a global.
 */
export function createSend(ctx: ChatContext, ops: { runCompaction: RunCompaction }) {
  const { db, loadOwnedChat, maxSeq, listByChat, openRouterRunner, runTurn, recordTurnEvents } =
    ctx;
  const { buildAssembleContext, resolveConfig, loadCanonHistory, embedder, summarizer } = ctx;
  const { runCompaction } = ops;

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
          // Compaction pickup: when the {{compact_summary}} marker put the summary in the prompt,
          // resend only the turns AFTER the compaction anchor (the summary covers the rest).
          const afterSeq =
            systemPrompt.trace.compactSummaryIncluded && chat.compactedAtSeq !== null
              ? chat.compactedAtSeq
              : undefined;
          turn = await openRouterRunner(routing.api)({
            model: routing.model,
            systemPrompt,
            history: await loadCanonHistory(params.chatId, { afterSeq }),
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

      // Managed compaction (opt-in): once the context-fill crosses the threshold, fire a steered
      // /compact NOW (we already hold the lock — runCompaction is lock-free) so the next turn starts
      // smaller. agent-sdk only; best-effort (a compaction failure never fails the just-saved turn).
      const compaction = promptConfig.params.compaction;
      if (routing.runner === "agent-sdk" && compaction?.mode === "managed") {
        const window = turn.usage.contextWindow;
        const used = turn.usage.tokensIn + turn.usage.tokensOut;
        const threshold = compaction.thresholdPct ?? MANAGED_COMPACT_DEFAULT_PCT;
        const sessionId = turn.sessionId || chat.sessionId;
        if (window !== null && window > 0 && used / window >= threshold && sessionId !== null) {
          await runCompaction({
            chatId: params.chatId,
            sessionId,
            model: routing.model,
            source: routing.source,
            systemPrompt,
            generation: promptConfig.params,
            instructions: compaction.instructions ?? DEFAULT_COMPACT_INSTRUCTIONS,
            trigger: "managed",
          });
        }
      }

      // Memory ({{memory}} digests): regenerate this chat's digests in the BACKGROUND after the
      // turn (fire-and-forget — never blocks the reply), gated on the opt-in knob + an enabled
      // memory marker. Idempotent/incremental; only OLDER messages (below verbatimWindow) digest,
      // so the turn just saved is untouched. Lock-free on purpose (taking the chat lock would make
      // the next send wait on summarization).
      const memCfg = promptConfig.params.memory;
      const hasMemoryMarker = promptConfig.sections.some(
        (s) => s.type === "marker" && s.marker === "memory" && s.enabled,
      );
      if (memCfg?.enabled === true && hasMemoryMarker) {
        void generateDigests(
          db,
          { embedder, summarizer },
          { chatId: params.chatId, params: memCfg },
        ).catch((err) =>
          getLog().warn(
            { chatId: params.chatId, err: err instanceof Error ? err.message : String(err) },
            "memory: background digest generation failed",
          ),
        );
      }

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

  return { send };
}
