import { randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { chats, messages, messageVariants, sessionEntries } from "../../../db/schema";
import type { ChatDeltaEvent } from "../../../shared/chat-types";
import { assemblePrompt } from "../../../shared/prompt-assemble";
import { getLog } from "../../observability/logger";
import { type ChatTurnResult, TurnError } from "../../providers/turn";
import { newId } from "../_shared/ids";
import { withChatLock } from "../_shared/lock";
import { ensureUser } from "../_shared/users";
import { OPEN_SCENE_PROMPT } from "./constants";
import type { ChatContext } from "./context";
import { resolveTurnRouting } from "./routing";
import { buildSeedFrames } from "./seed";
import { DbSessionStore } from "./store";
import { chatStreamEmitter } from "./stream";
import {
  ChatOperationError,
  type MessageView,
  type SelectVariantParams,
  type SendResult,
  type SwipeParams,
} from "./types";

/**
 * Swipe ops: `swipe` regenerates the LAST assistant turn as a new variant (mutates the tip, never
 * advances seq), and `selectVariant` makes an existing variant active (no model call, just repoint
 * + re-seed). Both use the variant pool on `message_variants`.
 */
export function createSwipe(ctx: ChatContext) {
  const { db, loadOwnedChat, loadOwnedMessage, maxSeq, listByChat, openRouterRunner } = ctx;
  const { loadCanonHistory, buildAssembleContext, resolveConfig, runTurn } = ctx;
  const { recordTurnEvents, reseedSdkSession } = ctx;

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
      const history = await loadCanonHistory(params.chatId, {
        beforeSeq: lastUser?.seq ?? tip.seq,
      });

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
        const onDelta = (event: ChatDeltaEvent) => {
          chatStreamEmitter.emit("delta", event);
        };

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
              onDelta,
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
              onDelta,
            });
          }
        } else {
          turn = await openRouterRunner(routing.api)({
            model: routing.model,
            chatId: params.chatId,
            systemPrompt,
            history: [...history, { role: "user", content: regenPrompt }],
            generation: promptConfig.params,
            providerRouting: routing.providerRouting,
            onDelta,
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

  return { swipe, selectVariant };
}
