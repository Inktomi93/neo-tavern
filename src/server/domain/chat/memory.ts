// Chat-history memory — the SillyTavern `vectors` extension model, adapted to our architecture.
// Embeds this chat's messages (lazily, per-message, ≤chunkChars) and, each turn, queries with the
// recent N to retrieve the most relevant OLDER messages — excluding the most recent `protect`
// (already in context) — above a cosine-similarity floor, optionally cross-encoder reranked. The
// formatted block fills the {{memory}} marker in the DYNAMIC (cache-safe) half (assemblePrompt
// stays pure; this is the async retrieval the caller runs first — same shape as compactSummary).
//
// Lives IN domain/chat (uses the embeddings INFRA directly — domain may import infra) — NOT a
// cross-feature dep on domain/corpus or domain/search. Retrieval is EXACT in-process cosine over
// just this chat's vectors (not the global ANN index): a single chat is small, and the ANN's
// global pool would mix in other chats / hit its result-budget ceiling (docs/conventions.md).

import { and, asc, eq, like } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { embeddings, messages } from "../../../db/schema";
import type { GenerationParams } from "../../../shared/generation";
import type { Embedder } from "../../embeddings/embedder";
import type { Reranker } from "../../embeddings/reranker";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";

const MEMORY_ENTITY = "chat_message";

// ST `vectors` defaults (settings block): query=2, insert=3, protect=5, score_threshold=0.25,
// message_chunk_size=400. Resolved per call from the preset's GenerationParams.memory.
const DEFAULTS = { queryMessages: 2, insert: 3, protect: 5, minScore: 0.25, chunkChars: 400 };

type MemoryConfig = NonNullable<GenerationParams["memory"]>;
export interface MemoryDeps {
  embedder: Embedder;
  reranker: Reranker;
}

// entityId = `${chatId}:${messageId}:${chunkIdx}` (chatId/messageId are nanoids — no ":" inside),
// so a `LIKE '<chatId>:%'` scopes to one chat and the messageId parses back out.
function memKey(chatId: string, messageId: string, chunkIdx: number): string {
  return `${chatId}:${messageId}:${chunkIdx}`;
}
function messageIdOf(entityId: string): string {
  return entityId.split(":")[1] ?? "";
}

// Greedy ≤max-char chunker (whitespace-collapsed, broken on spaces, never mid-word). Simple by
// design — ST's recursive splitter is overkill for RP messages.
function chunkText(text: string, max: number): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length === 0) return [];
  if (t.length <= max) return [t];
  const out: string[] = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(i + max, t.length);
    if (end < t.length) {
      const space = t.lastIndexOf(" ", end);
      if (space > i) end = space;
    }
    const piece = t.slice(i, end).trim();
    if (piece.length > 0) out.push(piece);
    i = end;
  }
  return out;
}

// Cosine of two L2-normalized vectors = their dot product (the embedder normalizes).
function cosineSim(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

// Embed any of this chat's user/assistant messages not yet embedded (idempotent + incremental):
// the first call on an existing chat embeds the backlog; later calls do only the new tail.
export async function embedChatMessages(
  db: Db,
  embedder: Embedder,
  chatId: string,
  chunkChars: number,
): Promise<number> {
  const msgs = await db
    .select({ id: messages.id, role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.seq));
  const already = new Set(
    (
      await db
        .select({ entityId: embeddings.entityId })
        .from(embeddings)
        .where(
          and(eq(embeddings.entityType, MEMORY_ENTITY), like(embeddings.entityId, `${chatId}:%`)),
        )
    ).map((r) => messageIdOf(r.entityId)),
  );
  const pending = msgs.filter(
    (m) => m.role !== "system" && !already.has(m.id) && m.content.trim().length > 0,
  );
  if (pending.length === 0) return 0;

  const chunks: { entityId: string; text: string }[] = [];
  for (const m of pending) {
    for (const [idx, c] of chunkText(m.content, chunkChars).entries()) {
      chunks.push({ entityId: memKey(chatId, m.id, idx), text: c });
    }
  }
  if (chunks.length === 0) return 0;

  const vecs = await embedder.embedBatch(chunks.map((c) => c.text));
  const now = Date.now();
  for (const [i, ch] of chunks.entries()) {
    const vec = vecs[i];
    if (vec === undefined) continue;
    await db
      .insert(embeddings)
      .values({
        id: newId(),
        entityType: MEMORY_ENTITY,
        entityId: ch.entityId,
        model: embedder.model,
        embedding: vec,
        sourceText: ch.text,
        createdAt: now,
      })
      .onConflictDoNothing();
  }
  getLog().debug({ chatId, messages: pending.length, chunks: chunks.length }, "memory: embedded");
  return pending.length;
}

/**
 * Retrieve the formatted memory block for a chat's NEXT turn, or null when nothing qualifies.
 * Mirrors ST's `rearrangeChat`: bail if history ≤ protect; query = the recent `queryMessages`;
 * exclude the recent `protect`; keep the top `insert` candidates above `minScore`; present them
 * chronologically as `Speaker: text`. The {{memory}} marker wraps this ("Past events:\n…").
 */
export async function retrieveMemory(
  db: Db,
  deps: MemoryDeps,
  opts: { chatId: string; params: MemoryConfig; charName: string; userName: string },
): Promise<string | null> {
  const cfg = {
    queryMessages: opts.params.queryMessages ?? DEFAULTS.queryMessages,
    insert: opts.params.insert ?? DEFAULTS.insert,
    protect: opts.params.protect ?? DEFAULTS.protect,
    minScore: opts.params.minScore ?? DEFAULTS.minScore,
    chunkChars: opts.params.chunkChars ?? DEFAULTS.chunkChars,
    rerank: opts.params.rerank ?? false,
  };

  const all = await db
    .select({ id: messages.id, seq: messages.seq, role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.chatId, opts.chatId))
    .orderBy(asc(messages.seq));
  const history = all.filter((m) => m.role !== "system" && m.content.trim().length > 0);
  if (history.length <= cfg.protect) return null; // nothing older than the protected window

  await embedChatMessages(db, deps.embedder, opts.chatId, cfg.chunkChars);

  const queryText = history
    .slice(-cfg.queryMessages)
    .map((m) => m.content)
    .join("\n")
    .trim();
  if (queryText.length === 0) return null;

  const protectedIds = new Set(history.slice(-cfg.protect).map((m) => m.id));
  const candidateIds = new Set(history.filter((m) => !protectedIds.has(m.id)).map((m) => m.id));
  if (candidateIds.size === 0) return null;

  const rows = await db
    .select({ entityId: embeddings.entityId, embedding: embeddings.embedding })
    .from(embeddings)
    .where(
      and(eq(embeddings.entityType, MEMORY_ENTITY), like(embeddings.entityId, `${opts.chatId}:%`)),
    );
  const queryVec = await deps.embedder.embed(queryText);

  // Best chunk similarity per candidate message (a message dedups to one entry, like ST's hashes).
  const bestSim = new Map<string, number>();
  for (const r of rows) {
    const mid = messageIdOf(r.entityId);
    if (!candidateIds.has(mid) || r.embedding === null) continue;
    const sim = cosineSim(queryVec, r.embedding);
    if (sim > (bestSim.get(mid) ?? Number.NEGATIVE_INFINITY)) bestSim.set(mid, sim);
  }

  let chosen = [...bestSim.entries()]
    .filter(([, sim]) => sim >= cfg.minScore)
    .sort((a, b) => b[1] - a[1])
    .slice(0, cfg.insert)
    .map(([mid]) => mid);
  if (chosen.length === 0) return null;

  const byId = new Map(history.map((m) => [m.id, m]));
  if (cfg.rerank) {
    const docs = chosen.map((mid) => ({ id: mid, text: byId.get(mid)?.content ?? "" }));
    const scores = await deps.reranker.rerank(queryText, docs);
    const order = new Map(scores.map((s, i) => [s.id, i]));
    chosen = [...chosen].sort(
      (a, b) =>
        (order.get(a) ?? Number.POSITIVE_INFINITY) - (order.get(b) ?? Number.POSITIVE_INFINITY),
    );
  }

  // Present chronologically (by seq) — "past events" read in order, regardless of match ranking.
  const label = (role: string): string => (role === "user" ? opts.userName : opts.charName);
  const block = chosen
    .map((mid) => byId.get(mid))
    .filter((m): m is NonNullable<typeof m> => m !== undefined)
    .sort((a, b) => a.seq - b.seq)
    .map((m) => `${label(m.role)}: ${m.content.trim()}`)
    .join("\n\n");
  getLog().debug({ chatId: opts.chatId, retrieved: chosen.length }, "memory: retrieved");
  return block.length > 0 ? block : null;
}
