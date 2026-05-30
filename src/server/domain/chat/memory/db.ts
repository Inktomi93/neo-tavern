import { and, asc, eq, gt, gte } from "drizzle-orm";
import type { Db } from "../../../../db/client";
import { parseStringArray } from "../../../../db/parsers";
import {
  characterVersions,
  chatDigests,
  chatSegments,
  chats,
  messages,
  personas,
} from "../../../../db/schema";
import type { Embedder } from "../../../embeddings/embedder";
import { newId } from "../../_shared/ids";
import type { ChatMeta, DigestRow, MsgRow, PendingDigest } from "./types";

export async function loadDigests(db: Db, chatId: string): Promise<DigestRow[]> {
  const rows = await db
    .select({
      tier: chatDigests.tier,
      blockIdx: chatDigests.blockIdx,
      seqStart: chatDigests.seqStart,
      seqEnd: chatDigests.seqEnd,
      text: chatDigests.text,
      keywords: chatDigests.keywords,
      createdAt: chatDigests.createdAt,
      embedding: chatDigests.embedding,
    })
    .from(chatDigests)
    .where(eq(chatDigests.chatId, chatId));
  return rows.map((r) => ({
    tier: r.tier,
    blockIdx: r.blockIdx,
    seqStart: r.seqStart,
    seqEnd: r.seqEnd,
    text: r.text,
    keywords: parseStringArray(r.keywords) ?? [],
    createdAt: r.createdAt,
    embedding: r.embedding,
  }));
}

export async function loadHistory(db: Db, chatId: string): Promise<MsgRow[]> {
  const rows = await db
    .select({
      seq: messages.seq,
      role: messages.role,
      content: messages.content,
      editedAt: messages.editedAt,
    })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.seq));
  return rows.filter((m) => m.role !== "system" && m.content.trim().length > 0);
}

// Resolve the chat's owner + pinned character version + display names (char = the cv name; user =
// the active-or-pinned persona, else "User"). Shared by generateDigests + generateSegments.
export async function loadChatMeta(db: Db, chatId: string): Promise<ChatMeta | null> {
  const rows = await db
    .select({
      ownerId: chats.ownerId,
      characterVersionId: chats.characterVersionId,
      personaId: chats.personaId,
      pinnedPersonaId: chats.pinnedPersonaId,
    })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  const chat = rows[0];
  if (!chat) return null;
  const cvRows = await db
    .select({ name: characterVersions.name })
    .from(characterVersions)
    .where(eq(characterVersions.id, chat.characterVersionId))
    .limit(1);
  const charName = cvRows[0]?.name ?? "Assistant";
  const personaId = chat.personaId ?? chat.pinnedPersonaId;
  let userName = "User";
  if (personaId) {
    const pRows = await db
      .select({ name: personas.name })
      .from(personas)
      .where(eq(personas.id, personaId))
      .limit(1);
    userName = pRows[0]?.name ?? "User";
  }
  return {
    ownerId: chat.ownerId,
    characterVersionId: chat.characterVersionId,
    charName,
    userName,
  };
}

export async function loadSegments(
  db: Db,
  chatId: string,
): Promise<{ blockIdx: number; seqStart: number; seqEnd: number; createdAt: number }[]> {
  return db
    .select({
      blockIdx: chatSegments.blockIdx,
      seqStart: chatSegments.seqStart,
      seqEnd: chatSegments.seqEnd,
      createdAt: chatSegments.createdAt,
    })
    .from(chatSegments)
    .where(eq(chatSegments.chatId, chatId));
}

// ── orphan reconcile (#2) ──────────────────────────────────────────────────────
// The block grid can SHRINK — a larger `blockSize`, or a message edited to empty (it drops from
// `loadHistory`) — leaving trailing high-`blockIdx` rows that map to no current block. Left alone
// they're injected into prompts / searched forever. These targeted DELETE WHEREs prune them (safe
// for the libsql vector index; only an unscoped bulk empty triggers the shadow-row footgun).

/** Drop digests in `tier` whose blockIdx is past the live grid (blockIdx >= validBlockCount). */
export async function pruneDigestOrphans(
  db: Db,
  chatId: string,
  tier: number,
  validBlockCount: number,
): Promise<void> {
  await db
    .delete(chatDigests)
    .where(
      and(
        eq(chatDigests.chatId, chatId),
        eq(chatDigests.tier, tier),
        gte(chatDigests.blockIdx, validBlockCount),
      ),
    );
}

/** Drop digests in tiers above the configured maxTier (it was lowered). */
export async function pruneDigestTiersAbove(
  db: Db,
  chatId: string,
  maxTier: number,
): Promise<void> {
  await db
    .delete(chatDigests)
    .where(and(eq(chatDigests.chatId, chatId), gt(chatDigests.tier, maxTier)));
}

/** Drop segments whose blockIdx is past the live grid (blockIdx >= validBlockCount). */
export async function pruneSegmentOrphans(
  db: Db,
  chatId: string,
  validBlockCount: number,
): Promise<void> {
  await db
    .delete(chatSegments)
    .where(and(eq(chatSegments.chatId, chatId), gte(chatSegments.blockIdx, validBlockCount)));
}

// Embed the staged digests in ONE batched GPU pass, then upsert (idempotent on the unique
// (chatId,tier,blockIdx) — a regenerated block overwrites in place). Returns how many were written.
export async function embedAndUpsert(
  db: Db,
  embedder: Embedder,
  chatId: string,
  ownerId: string,
  characterVersionId: string,
  rows: PendingDigest[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const vecs = await embedder.embedBatch(rows.map((r) => r.text));
  const createdAt = Date.now();
  let written = 0;
  for (const [i, r] of rows.entries()) {
    const vec = vecs[i];
    if (vec === undefined) continue;
    const fields = {
      seqStart: r.seqStart,
      seqEnd: r.seqEnd,
      text: r.text,
      topicAnchor: r.topicAnchor,
      keywords: r.keywords,
      model: embedder.model,
      summarizerModel: r.summarizerModel,
      embedding: vec,
      // Rough token estimate (cost visibility); the embedder enforces the real BGE-M3 8192 cap.
      tokens: Math.round(r.text.length / 4),
      createdAt,
    };
    await db
      .insert(chatDigests)
      .values({
        id: newId(),
        chatId,
        ownerId,
        characterVersionId,
        tier: r.tier,
        blockIdx: r.blockIdx,
        ...fields,
      })
      .onConflictDoUpdate({
        target: [chatDigests.chatId, chatDigests.tier, chatDigests.blockIdx],
        set: fields,
      });
    written += 1;
  }
  return written;
}

// ── generation (background; never on the reply critical path) ──────────────────

/**
 * (Re)build this chat's digests from canon: segment OLDER messages (aged below `verbatimWindow`) into
 * `blockSize` tier-0 blocks, (re)digest stale/missing ones independently, then consolidate filled
 * tiers up to `maxTier`. Idempotent + incremental — only stale/missing blocks call the summarizer.
 * Stale = the block's span changed (grew) OR a contained message was edited after the digest was
 * written (`editedAt > createdAt`); a regenerated child marks its parent stale (bounded vertical
 * cascade). Returns how many digests were (re)written. Used live (post-turn) and for bulk backfill.
 */
export async function recentQueryText(
  db: Db,
  chatId: string,
  window: number,
  pendingUserText?: string,
): Promise<string> {
  const hist = await loadHistory(db, chatId); // filtered: no system rows, no empty content
  const contents = hist.map((m) => m.content);
  // The in-flight user turn isn't committed yet at assembly time; append it (subject to the same
  // non-empty rule) so a `send`'s query reflects the message being answered, not the prior exchange.
  if (pendingUserText !== undefined && pendingUserText.trim().length > 0) {
    contents.push(pendingUserText);
  }
  return contents.slice(-window).join("\n").trim();
}
