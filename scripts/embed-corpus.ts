import process from "node:process";
import { asc, eq } from "drizzle-orm";
import { createDb, runMigrations } from "../src/db/client";
import { characters, characterVersions, chats, messages } from "../src/db/schema";
import {
  buildCardEmbedText,
  createCorpusService,
  type EmbedItem,
  embeddingKey,
  MIN_SEARCH_TEXT_TOKENS,
  segmentChat,
} from "../src/server/domain/corpus";
import { createBgeTokenizer } from "../src/server/embeddings/tokenizer";
import { env } from "../src/server/env";

/**
 * Embed pass (Phase 4.6.2): index the imported corpus for semantic search. Embeds each
 * character's current-version card + each real_conversation chat's segments via BGE-M3.
 * Uses the REAL BGE-M3 tokenizer (native, fast) to: drop degenerate cards (< 150 tok),
 * sort by real length, and pack TOKEN-BUDGET batches (cap padded tokens/batch, not a fixed
 * count — fixed-count + long text OOMs). Resumable. GPU via `pnpm embed:corpus:gpu`.
 * entityId: card = "<characterId>", segment = "<chatId>:<segIndex>".
 */
// Padded-token budget per GPU batch (max_seq_len × batch_size). With length-sorting this is
// tight. BGE-M3 (568M) is small, so this is generous for the 48GB A6000s.
const MAX_BATCH_TOKENS = 32768;
// Coarse char pre-cap (~8192 tok · BGE-M3's own pipeline truncates at 8192 anyway) — just
// avoids tokenizing/feeding a needlessly huge string. Real truncation is the pipeline's.
const MAX_EMBED_CHARS = 8192 * 4;
const TOKENIZE_CHUNK = 512;

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function cap(text: string): string {
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

async function main(): Promise<void> {
  console.log(
    `[embed] DB ${env.DATABASE_URL} · device=${env.EMBED_DEVICE} dtype=${env.EMBED_DTYPE} budget=${MAX_BATCH_TOKENS}tok`,
  );
  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);
  const corpus = createCorpusService(db);
  const tok = createBgeTokenizer();
  const done = await corpus.existingKeys();

  const versions = await db.select().from(characterVersions);
  const versionById = new Map(versions.map((v) => [v.id, v]));

  // ── Collect every embed target (cards + real_conversation segments) ──────
  let skipped = 0;
  const targets: EmbedItem[] = [];
  for (const c of await db.select().from(characters)) {
    if (!c.currentVersionId) continue;
    const v = versionById.get(c.currentVersionId);
    if (!v) continue;
    if (done.has(embeddingKey("character", c.id))) {
      skipped += 1;
      continue;
    }
    const text = buildCardEmbedText({
      name: v.name,
      description: v.description,
      personality: v.personality,
      scenario: v.scenario,
      firstMessage: v.firstMessage,
      alternateGreetings: strArray(v.alternateGreetings),
      tags: strArray(v.tags),
    });
    targets.push({
      entityType: "character",
      entityId: c.id,
      text: cap(text),
      metadata: { name: v.name },
    });
  }

  const allChats = await db.select().from(chats);
  const real = allChats.filter(
    (ch) => (ch.metadata as { bucket?: string } | null)?.bucket === "real_conversation",
  );
  console.log(`[embed] ${targets.length} cards · segmenting ${real.length} chats…`);
  let i = 0;
  for (const ch of real) {
    i += 1;
    const v = versionById.get(ch.characterVersionId);
    const charName = v?.name ?? "Character";
    const characterId = v?.characterId;
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.chatId, ch.id))
      .orderBy(asc(messages.seq));
    const segMsgs = rows
      .filter((m) => m.role !== "system")
      .map((m) => ({
        isUser: m.role === "user",
        speaker: m.role === "user" ? "User" : charName,
        content: m.content,
        sendDate: m.createdAt,
      }));
    const chatDate = new Date(ch.createdAt).toISOString().slice(0, 10);
    for (const seg of segmentChat(segMsgs, { characterName: charName, chatDate })) {
      const entityId = `${ch.id}:${seg.index}`;
      if (done.has(embeddingKey("chat_segment", entityId))) {
        skipped += 1;
        continue;
      }
      targets.push({
        entityType: "chat_segment",
        entityId,
        text: cap(seg.text),
        metadata: { characterId, chatId: ch.id, segIndex: seg.index },
      });
    }
    if (i % 100 === 0)
      console.log(`[embed] segmented ${i}/${real.length} · ${targets.length} targets`);
  }

  // ── Real token counts → drop degenerate cards → sort → token-budget batch ──
  console.log(`[embed] tokenizing ${targets.length} targets (real BGE-M3)…`);
  const toks: number[] = [];
  for (let b = 0; b < targets.length; b += TOKENIZE_CHUNK) {
    toks.push(...(await tok.countBatch(targets.slice(b, b + TOKENIZE_CHUNK).map((t) => t.text))));
  }
  const withToks = targets
    .map((t, idx) => ({ item: t, tokens: toks[idx] ?? 0 }))
    // degenerate filter: tiny CARDS match everything (still directly retrievable). config.py:76
    .filter((x) => x.item.entityType !== "character" || x.tokens >= MIN_SEARCH_TEXT_TOKENS)
    .sort((a, b) => a.tokens - b.tokens); // length-sort → tight padded batches
  const cardsSkippedSmall =
    targets.filter((t) => t.entityType === "character").length -
    withToks.filter((x) => x.item.entityType === "character").length;

  let embedded = 0;
  let batch: EmbedItem[] = [];
  let batchMax = 0;
  const flush = async (): Promise<void> => {
    if (batch.length > 0) {
      embedded += await corpus.embedAndStoreMany(batch);
      batch = [];
      batchMax = 0;
      console.log(`[embed] ${embedded}/${withToks.length} embedded…`);
    }
  };
  for (const { item, tokens } of withToks) {
    const newMax = Math.max(batchMax, tokens);
    if (batch.length > 0 && newMax * (batch.length + 1) > MAX_BATCH_TOKENS) await flush();
    batch.push(item);
    batchMax = Math.max(batchMax, tokens);
  }
  await flush();

  console.log(
    `[embed] ✅ ${embedded} embedded · ${cardsSkippedSmall} cards too small · ${skipped} already-present skipped`,
  );
}

await main().catch((error: unknown) => {
  console.error("[embed] failed:", error);
  process.exitCode = 1;
});
