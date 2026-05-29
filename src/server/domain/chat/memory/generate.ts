import type { Db } from "../../../../db/client";
import { chatSegments } from "../../../../db/schema";
import type { Embedder } from "../../../embeddings/embedder";
import { getLog } from "../../../observability/logger";
import { newId } from "../../_shared/ids";
import { CONSOLIDATE_SYSTEM, DEFAULTS, DIGEST_SCHEMA, TIER0_SYSTEM } from "./constants";
import { embedAndUpsert, loadChatMeta, loadDigests, loadHistory, loadSegments } from "./db";
import type { GenerateDigestsDeps, MemoryConfig, PendingDigest } from "./types";
import { chunk, parseDigest, renderTranscript, resolveCfg } from "./utils";

export async function generateDigests(
  db: Db,
  deps: GenerateDigestsDeps,
  opts: { chatId: string; params: MemoryConfig },
): Promise<{ written: number }> {
  const cfg = resolveCfg(opts.params);
  if (!cfg.enabled || cfg.mode === "off") return { written: 0 };

  const chat = await loadChatMeta(db, opts.chatId);
  if (!chat) return { written: 0 };
  const { charName, userName } = chat;

  const history = await loadHistory(db, opts.chatId);
  if (history.length === 0) return { written: 0 };

  // Dormancy / eligibility: only digest messages aged below the verbatim window. A fresh chat (or one
  // with < one block aged out) does nothing — the seam buffer keeps live swipes/edits off digests.
  const maxSeq = history[history.length - 1]?.seq ?? 0;
  const cutoff = maxSeq - cfg.verbatimWindow;
  const older = history.filter((m) => m.seq <= cutoff);
  if (older.length < cfg.blockSize) return { written: 0 };

  const summarizeOpts = {
    source: cfg.summarizerSource,
    maxTokens: cfg.summarizerMaxTokens,
    temperature: cfg.summarizerTemperature,
    jsonSchema: DIGEST_SCHEMA, // grammar-constrain the local path; the hosted path is prompted for it
  };
  let totalWritten = 0;
  let pending: PendingDigest[] = [];
  let existing = await loadDigests(db, opts.chatId);
  const at = (tier: number, blockIdx: number) =>
    existing.find((d) => d.tier === tier && d.blockIdx === blockIdx);

  // tier 0 — independent per-block digests.
  const blocks = chunk(older, cfg.blockSize);
  for (const [i, block] of blocks.entries()) {
    const first = block[0];
    const last = block[block.length - 1];
    if (!first || !last) continue;
    const seqStart = first.seq;
    const seqEnd = last.seq;
    const prev = at(0, i);
    const stale =
      !prev ||
      prev.seqStart !== seqStart ||
      prev.seqEnd !== seqEnd ||
      block.some((m) => m.editedAt !== null && m.editedAt > prev.createdAt);
    if (!stale) continue;
    const userPrompt = `Conversation block (messages ${seqStart}-${seqEnd}):\n\n${renderTranscript(block, charName, userName)}\n\nWrite the digest:`;
    const res = await deps.summarizer.summarize(TIER0_SYSTEM, userPrompt, summarizeOpts);
    const parsed = parseDigest(res.text);
    if (parsed.text.length === 0) continue;
    pending.push({ tier: 0, blockIdx: i, seqStart, seqEnd, summarizerModel: res.model, ...parsed });
  }
  if (pending.length > 0) {
    totalWritten += await embedAndUpsert(
      db,
      deps.embedder,
      opts.chatId,
      chat.ownerId,
      chat.characterVersionId,
      pending,
    );
    existing = await loadDigests(db, opts.chatId);
    pending = [];
  }

  // tiers 1..maxTier — consolidate `fanOut` lower-tier digests into one coarser digest. Deterministic
  // by blockIdx: parent block i covers children [i*fanOut, (i+1)*fanOut). A parent is stale if any
  // child was (re)written after it, or its covered span changed.
  for (let k = 0; k < cfg.maxTier; k++) {
    const tierK = existing.filter((d) => d.tier === k).sort((a, b) => a.blockIdx - b.blockIdx);
    const groups = Math.floor(tierK.length / cfg.fanOut);
    const priorConsolidations: string[] = [];
    for (let i = 0; i < groups; i++) {
      const children = tierK.slice(i * cfg.fanOut, (i + 1) * cfg.fanOut);
      const cFirst = children[0];
      const cLast = children[children.length - 1];
      if (!cFirst || !cLast) continue;
      const seqStart = cFirst.seqStart;
      const seqEnd = cLast.seqEnd;
      const parent = existing.find((d) => d.tier === k + 1 && d.blockIdx === i);
      const stale =
        !parent ||
        parent.seqStart !== seqStart ||
        parent.seqEnd !== seqEnd ||
        children.some((c) => c.createdAt > parent.createdAt);
      if (!stale) {
        if (parent) priorConsolidations.push(parent.text);
        continue;
      }
      const priorBlock =
        priorConsolidations.length > 0
          ? `Prior consolidated digests (do NOT repeat):\n${priorConsolidations.join("\n\n")}\n\n`
          : "";
      const childBlock = children.map((c) => c.text).join("\n\n");
      const userPrompt = `${priorBlock}New digests to merge (scenes ${seqStart}-${seqEnd}):\n\n${childBlock}\n\nWrite the consolidated digest:`;
      const res = await deps.summarizer.summarize(CONSOLIDATE_SYSTEM, userPrompt, summarizeOpts);
      const parsed = parseDigest(res.text);
      if (parsed.text.length === 0) continue;
      priorConsolidations.push(parsed.text);
      pending.push({
        tier: k + 1,
        blockIdx: i,
        seqStart,
        seqEnd,
        summarizerModel: res.model,
        ...parsed,
      });
    }
    if (pending.length > 0) {
      totalWritten += await embedAndUpsert(
        db,
        deps.embedder,
        opts.chatId,
        chat.ownerId,
        chat.characterVersionId,
        pending,
      );
      existing = await loadDigests(db, opts.chatId);
      pending = [];
    }
  }

  getLog().debug(
    { chatId: opts.chatId, tier0Blocks: blocks.length, written: totalWritten },
    "memory: digests generated",
  );
  return { written: totalWritten };
}

/**
 * (Re)build this chat's raw SEGMENTS — the verbatim half of the hybrid corpus search (docs/memory.md
 * §4). Same blockSize boundary as digests, but indexes EVERY complete block across the WHOLE chat (no
 * verbatimWindow cutoff — the cross-chat search tool wants all of it findable; the still-forming
 * trailing partial block is skipped to avoid per-turn re-embed churn). Embed-only (no summarizer →
 * cheap), so it runs for ALL chats regardless of memory.enabled. Idempotent/incremental: only
 * stale/missing blocks re-embed (span changed, or a contained message edited after the segment).
 */
export async function generateSegments(
  db: Db,
  deps: { embedder: Embedder },
  opts: { chatId: string; blockSize?: number | undefined },
): Promise<{ written: number }> {
  const blockSize = opts.blockSize ?? DEFAULTS.blockSize;
  const meta = await loadChatMeta(db, opts.chatId);
  if (!meta) return { written: 0 };
  const history = await loadHistory(db, opts.chatId);
  if (history.length === 0) return { written: 0 };

  const existing = new Map((await loadSegments(db, opts.chatId)).map((s) => [s.blockIdx, s]));
  // ALL blocks across the whole chat, INCLUDING the trailing partial (or a whole sub-blockSize chat),
  // so every chat is searchable — 100% corpus coverage (vs complete-blocks-only = 54%). The trailing
  // partial re-embeds as it grows (the seqEnd staleness check). Segments don't get the verbatimWindow
  // protection digests do — the corpus wants everything searchable; the tip just re-embeds on change.
  const blocks = chunk(history, blockSize);
  const pending: { blockIdx: number; seqStart: number; seqEnd: number; text: string }[] = [];
  for (const [i, block] of blocks.entries()) {
    const first = block[0];
    const last = block[block.length - 1];
    if (!first || !last) continue;
    const text = renderTranscript(block, meta.charName, meta.userName);
    if (text.trim().length === 0) continue; // skip a genuinely empty block
    const prev = existing.get(i);
    const stale =
      !prev ||
      prev.seqStart !== first.seq ||
      prev.seqEnd !== last.seq ||
      block.some((m) => m.editedAt !== null && m.editedAt > prev.createdAt);
    if (!stale) continue;
    pending.push({ blockIdx: i, seqStart: first.seq, seqEnd: last.seq, text });
  }
  if (pending.length === 0) return { written: 0 };

  const vecs = await deps.embedder.embedBatch(pending.map((p) => p.text));
  const createdAt = Date.now();
  let written = 0;
  for (const [i, p] of pending.entries()) {
    const vec = vecs[i];
    if (vec === undefined) continue;
    const fields = {
      seqStart: p.seqStart,
      seqEnd: p.seqEnd,
      text: p.text,
      model: deps.embedder.model,
      embedding: vec,
      // Rough token estimate (cost visibility); the embedder enforces the real BGE-M3 8192 cap.
      tokens: Math.round(p.text.length / 4),
      createdAt,
    };
    await db
      .insert(chatSegments)
      .values({
        id: newId(),
        chatId: opts.chatId,
        ownerId: meta.ownerId,
        characterVersionId: meta.characterVersionId,
        blockIdx: p.blockIdx,
        ...fields,
      })
      .onConflictDoUpdate({
        target: [chatSegments.chatId, chatSegments.blockIdx],
        set: fields,
      });
    written += 1;
  }
  getLog().debug({ chatId: opts.chatId, written }, "memory: segments generated");
  return { written };
}

// ── retrieval (cheap; on the reply critical path) ──────────────────────────────
