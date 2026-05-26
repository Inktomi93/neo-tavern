import { randomUUID } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import { chats, chatWorldEntries, messages, sessionEntries } from "../../../db/schema";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";
import { withChatLock } from "../_shared/lock";
import { ensureUser } from "../_shared/users";
import type { ChatContext } from "./context";
import { buildSeedFrames, type SeedTurn } from "./seed";
import { DbSessionStore } from "./store";
import { ChatOperationError, type ForkChatParams, type SetProviderParams } from "./types";

/**
 * Branch ops — reshape how/where a chat continues: `forkChat` branches the canon into a NEW chat
 * at a seq, and `setProvider` switches a chat's api/source/model in place. Both manage the
 * agent-sdk session (seed on enter, drop on leave) around the canon, which always stays.
 */
export function createBranch(ctx: ChatContext) {
  const { db, loadOwnedChat, seedSessionFromCanon } = ctx;

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
    // Carry the compaction artifact only if the fork point includes the compaction anchor (so the
    // forked range is genuinely "post-compaction"); a fork before it predates compaction → none.
    // This is what lets a compacted agent-sdk chat fork into openrouter and pick up from the summary.
    const carryCompaction = source.compactedAtSeq !== null && source.compactedAtSeq <= params.atSeq;
    await db.insert(chats).values({
      id: newChatId,
      ownerId,
      title: `${source.title} (fork)`,
      characterVersionId: source.characterVersionId, // the PIN — shared immutable version, not a copy
      personaId: source.personaId,
      pinnedPersonaId: source.pinnedPersonaId, // preserve the pinned identity across the fork
      presetVersionId: source.presetVersionId,
      api: params.targetApi,
      source: params.targetSource,
      model,
      sessionId,
      compactSummary: carryCompaction ? source.compactSummary : null,
      compactedAtSeq: carryCompaction ? source.compactedAtSeq : null,
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

  return { forkChat, setProvider };
}
