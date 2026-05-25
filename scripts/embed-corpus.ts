import process from "node:process";
import { asc, eq } from "drizzle-orm";
import { createDb, runMigrations } from "../src/db/client";
import { characters, characterVersions, chats, messages } from "../src/db/schema";
import {
  approxTokens,
  buildCardEmbedText,
  createCorpusService,
  type EmbedItem,
  embeddingKey,
  MIN_SEARCH_TEXT_TOKENS,
  segmentChat,
} from "../src/server/domain/corpus";
import { env } from "../src/server/env";

/**
 * Embed pass (Phase 4.6.2): index the imported corpus for semantic search. Embeds each
 * character's current-version card + each real_conversation chat's segments via BGE-M3,
 * BATCHED (one GPU pass per BATCH_SIZE texts — the throughput lever). Resumable: skips
 * already-embedded entities. SLOW on CPU; run on GPU via `pnpm embed:corpus:gpu`. Not in
 * `pnpm check`. entityId: card = "<characterId>", segment = "<chatId>:<segIndex>".
 */
const BATCH_SIZE = 32;
// Context cap = BGE-M3's full 8192-token window (~4 chars/token). With length-bucketing
// below, padding waste is already handled, so this is just "never exceed the model max"
// (silent truncation otherwise). A longer-context model would raise this — see the model
// note in docs/corpus-import.md.
const MAX_EMBED_CHARS = 8192 * 4;

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function cap(text: string): string {
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

async function main(): Promise<void> {
  console.log(
    `[embed] DB ${env.DATABASE_URL} · device=${env.EMBED_DEVICE} dtype=${env.EMBED_DTYPE} batch=${BATCH_SIZE}`,
  );
  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);
  const corpus = createCorpusService(db);
  const done = await corpus.existingKeys(); // resumability: skip what's already embedded

  const versions = await db.select().from(characterVersions);
  const versionById = new Map(versions.map((v) => [v.id, v]));

  let cardsSkippedSmall = 0;
  let skipped = 0;
  // Collect everything first, then sort by length so each GPU batch is similar-sized
  // (minimizes padding waste — card-curator index.py:219 / sentence-transformers do the same).
  const targets: EmbedItem[] = [];

  // ── Cards (current version per character) ───────────────────────────────
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
    if (approxTokens(text) < MIN_SEARCH_TEXT_TOKENS) {
      cardsSkippedSmall += 1; // degenerate-result filter — still directly retrievable
      continue;
    }
    targets.push({
      entityType: "character",
      entityId: c.id,
      text: cap(text),
      metadata: { name: v.name },
    });
  }

  // ── Chat segments (real_conversation only) ──────────────────────────────
  const allChats = await db.select().from(chats);
  const real = allChats.filter(
    (ch) => (ch.metadata as { bucket?: string } | null)?.bucket === "real_conversation",
  );
  console.log(
    `[embed] cards queued (${cardsSkippedSmall} too small) · ${real.length} chats to segment`,
  );

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
    if (i % 100 === 0) console.log(`[embed] segmented ${i}/${real.length} chats…`);
  }

  // Sort by length → consecutive batches hold similar-sized texts (minimal padding waste).
  targets.sort((a, b) => a.text.length - b.text.length);
  let embedded = 0;
  for (let b = 0; b < targets.length; b += BATCH_SIZE) {
    embedded += await corpus.embedAndStoreMany(targets.slice(b, b + BATCH_SIZE));
    console.log(`[embed] ${embedded}/${targets.length} embedded…`);
  }

  console.log(
    `[embed] ✅ ${embedded} embedded · ${cardsSkippedSmall} cards too small · ${skipped} already-present skipped`,
  );
}

await main().catch((error: unknown) => {
  console.error("[embed] failed:", error);
  process.exitCode = 1;
});
