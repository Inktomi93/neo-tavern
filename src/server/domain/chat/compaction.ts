import { eq } from "drizzle-orm";
import { chats } from "../../../db/schema";
import type { ChatModelId } from "../../../shared/models";
import { assemblePrompt } from "../../../shared/prompt-assemble";
import type { PromptConfig } from "../../../shared/prompt-config";
import { getLog } from "../../observability/logger";
import type { ClaudeSource } from "../../providers/claude-sdk";
import { TurnError } from "../../providers/turn";
import { withChatLock } from "../_shared/lock";
import { ensureUser } from "../_shared/users";
import { DEFAULT_COMPACT_INSTRUCTIONS } from "./constants";
import type { ChatContext } from "./context/factory";
import { resolveTurnRouting } from "./routing";
import { DbSessionStore } from "./store";
import type { CompactParams } from "./types";

/**
 * Compaction ops: the lock-free `runCompaction` core (shared by send()'s managed auto-trigger and
 * the manual `compact`) plus the manual `compact` lever. Split out so send() can depend on
 * `runCompaction` explicitly (wired at the composition root) without the two living in one file.
 */
export function createCompaction(ctx: ChatContext) {
  const { db, runTurn, recordTurnEvents, extractCompactSummary, maxSeq } = ctx;
  const { loadOwnedChat, buildAssembleContext, resolveConfig } = ctx;

  // Lock-free compaction core: run a steered `/compact` turn (resume the session, compact, no reply,
  // no message row) → repoint the session + record the compaction event. Shared by the manual
  // compact() (takes the lock) and the managed auto-trigger inside send() (already holds the lock —
  // so this MUST stay lock-free to avoid a re-entrant deadlock). Best-effort: a TurnError → false.
  async function runCompaction(args: {
    chatId: string;
    sessionId: string;
    model: ChatModelId;
    source: ClaudeSource;
    systemPrompt: { static: string; dynamic: string };
    generation: PromptConfig["params"];
    instructions: string;
    trigger: "manual" | "managed";
  }): Promise<boolean> {
    try {
      const turn = await runTurn({
        prompt: `/compact ${args.instructions}`,
        model: args.model,
        source: args.source,
        sessionStore: new DbSessionStore(db, args.chatId),
        systemPrompt: args.systemPrompt,
        generation: args.generation,
        resume: args.sessionId,
      });
      const newSessionId = turn.sessionId || args.sessionId;
      // Capture the SDK's summary + the canon anchor it covers → the portable, cross-mode artifact
      // (openrouter mode reads these to pick up from the compaction point). Best-effort: if we can't
      // recover the summary frame, leave compactSummary/anchor untouched (degrade to full canon).
      const summary = await extractCompactSummary(newSessionId);
      const anchorSeq = summary !== null ? await maxSeq(args.chatId) : null;
      await db
        .update(chats)
        .set({
          sessionId: newSessionId,
          ...(summary !== null ? { compactSummary: summary, compactedAtSeq: anchorSeq } : {}),
          updatedAt: Date.now(),
        })
        .where(eq(chats.id, args.chatId));
      await recordTurnEvents(args.chatId, null, turn.events);
      getLog().info(
        {
          chatId: args.chatId,
          trigger: args.trigger,
          events: turn.events.length,
          summaryCaptured: summary !== null,
        },
        "chat: compacted",
      );
      return true;
    } catch (error) {
      if (error instanceof TurnError) {
        getLog().warn(
          { chatId: args.chatId, trigger: args.trigger, kind: error.kind },
          "chat: compaction failed",
        );
        return false;
      }
      throw error;
    }
  }

  // Manually compact an agent-sdk chat's session via a steered `/compact` turn (the lever for
  // compaction mode "off"/"managed"). No-op for openrouter (stateless — nothing to compact) or a
  // chat with no session yet. Canon (the messages) is untouched.
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
      const compacted = await runCompaction({
        chatId: params.chatId,
        sessionId: chat.sessionId,
        model: routing.model,
        source: routing.source,
        systemPrompt: assemblePrompt(promptConfig, assembleCtx),
        generation: promptConfig.params,
        instructions:
          params.instructions ??
          promptConfig.params.compaction?.instructions ??
          DEFAULT_COMPACT_INSTRUCTIONS,
        trigger: "manual",
      });
      return { compacted };
    });
  }

  return { runCompaction, compact };
}

/** The lock-free compaction core, as wired into send() at the composition root. */
export type RunCompaction = ReturnType<typeof createCompaction>["runCompaction"];
