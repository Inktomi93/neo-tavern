import { asc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characters, characterVersions, chats, messages } from "../../../db/schema";
import { getLog } from "../../observability/logger";
import { buildCardEmbedText } from "./embed-text";
import { segmentChat } from "./segment";
import type { EmbedItem } from "./service";

// Coarse char pre-cap (~8192 tok · BGE-M3 truncates at 8192 internally anyway) — keeps the
// stored source_text == the text that was embedded, so the reranker scores what was indexed.
const MAX_EMBED_CHARS = 8192 * 4;

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function cap(text: string): string {
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

/**
 * Assemble every embed target — each character's current-version card + each
 * `real_conversation` chat's segments — with its final embed text and metadata. The single
 * source of truth for "what text represents each entity", shared by the embed pass
 * (`scripts/embed-corpus`) and the source_text backfill (`scripts/backfill-source-text`) so
 * the text is built ONE way. No `existingKeys` / degenerate filtering — callers decide what
 * to skip (the embed pass skips done + tiny cards; the backfill matches existing rows).
 * entityId: card = "<characterId>", segment = "<chatId>:<segIndex>".
 */
export async function collectEmbedTargets(db: Db): Promise<EmbedItem[]> {
  const versions = await db.select().from(characterVersions);
  const versionById = new Map(versions.map((v) => [v.id, v]));

  const targets: EmbedItem[] = [];
  for (const c of await db.select().from(characters)) {
    if (!c.currentVersionId) continue;
    const v = versionById.get(c.currentVersionId);
    if (!v) continue;
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
  for (const ch of real) {
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
      targets.push({
        entityType: "chat_segment",
        entityId: `${ch.id}:${seg.index}`,
        text: cap(seg.text),
        metadata: { characterId, chatId: ch.id, segIndex: seg.index },
      });
    }
  }
  const cards = targets.filter((t) => t.entityType === "character").length;
  getLog().debug(
    { targets: targets.length, cards, segments: targets.length - cards },
    "corpus: collected embed targets",
  );
  return targets;
}
