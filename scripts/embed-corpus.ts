import process from "node:process";
import { asc, eq } from "drizzle-orm";
import { createDb, runMigrations } from "../src/db/client";
import { characters, characterVersions, chats, messages } from "../src/db/schema";
import {
  approxTokens,
  buildCardEmbedText,
  createCorpusService,
  embeddingKey,
  MIN_SEARCH_TEXT_TOKENS,
  segmentChat,
} from "../src/server/domain/corpus";
import { env } from "../src/server/env";

/**
 * Embed pass (Phase 4.6.2): index the imported corpus for semantic search. Embeds each
 * character's current-version card text and each real_conversation chat's segments via
 * BGE-M3, upserting into `embeddings`. SLOW (CPU model, minutes) — run after `import:st`
 * into the same DATABASE_URL. Resumable: already-embedded entities are skipped. Run:
 * `pnpm embed:corpus`. NOT part of `pnpm check`.
 *
 * entityId convention: card = "<characterId>"; segment = "<chatId>:<segIndex>".
 */
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

async function main(): Promise<void> {
  console.log(`[embed] DB ${env.DATABASE_URL} (model loads on first embed; downloads once)`);
  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);
  const corpus = createCorpusService(db);
  const done = await corpus.existingKeys(); // resumability: skip what's already embedded

  const versions = await db.select().from(characterVersions);
  const versionById = new Map(versions.map((v) => [v.id, v]));

  // ── Cards (current version per character) ───────────────────────────────
  let cards = 0;
  let cardsSkippedSmall = 0;
  let skipped = 0;
  const chars = await db.select().from(characters);
  for (const c of chars) {
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
      exampleMessages: v.exampleMessages,
      creatorNotes: v.creatorNotes,
      systemPrompt: v.systemPrompt,
      postHistoryInstructions: v.postHistoryInstructions,
      alternateGreetings: strArray(v.alternateGreetings),
      tags: strArray(v.tags),
    });
    if (approxTokens(text) < MIN_SEARCH_TEXT_TOKENS) {
      cardsSkippedSmall += 1; // degenerate-result filter — still directly retrievable
      continue;
    }
    await corpus.embedAndStore({
      entityType: "character",
      entityId: c.id,
      text,
      metadata: { name: v.name },
    });
    cards += 1;
    if (cards % 25 === 0) console.log(`[embed] cards ${cards}…`);
  }

  // ── Chat segments (real_conversation only) ──────────────────────────────
  const allChats = await db.select().from(chats);
  const real = allChats.filter(
    (ch) => (ch.metadata as { bucket?: string } | null)?.bucket === "real_conversation",
  );
  console.log(
    `[embed] cards done (${cards} embedded, ${cardsSkippedSmall} too small) · ${real.length} chats to segment`,
  );

  let segs = 0;
  let i = 0;
  for (const ch of real) {
    i += 1;
    const charName = versionById.get(ch.characterVersionId)?.name ?? "Character";
    const characterId = versionById.get(ch.characterVersionId)?.characterId;
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
      await corpus.embedAndStore({
        entityType: "chat_segment",
        entityId,
        text: seg.text,
        metadata: { characterId, chatId: ch.id, segIndex: seg.index },
      });
      segs += 1;
    }
    if (i % 50 === 0) console.log(`[embed] chats ${i}/${real.length} · ${segs} segments…`);
  }

  console.log(
    `[embed] ✅ ${cards} cards · ${segs} segments embedded · ${skipped} already-present skipped`,
  );
}

await main().catch((error: unknown) => {
  console.error("[embed] failed:", error);
  process.exitCode = 1;
});
