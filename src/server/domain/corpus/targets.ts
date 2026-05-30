import type { Db } from "../../../db/client";
import { characters, characterVersions } from "../../../db/schema";
import { getLog } from "../../observability/logger";
import { buildCardEmbedText, type EmbedItem } from "./embed-text";

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
 * entityId: card = "<characterId>". (Phase B: chat segments are no longer embedded here — they're
 * the first-class chat_segments table, generated live per-block by domain/chat/memory.ts.)
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
      // greetings is the unified array ([0] = first message); split it back for the embed-text
      // builder so the embedded text is identical to the pre-fold shape.
      firstMessage: strArray(v.greetings)[0] ?? null,
      alternateGreetings: strArray(v.greetings).slice(1),
      tags: strArray(v.tags),
    });
    targets.push({
      characterId: c.id,
      ownerId: c.ownerId,
      characterVersionId: v.id,
      text: cap(text),
    });
  }

  getLog().debug({ targets: targets.length }, "corpus: collected embed targets (character cards)");
  return targets;
}
