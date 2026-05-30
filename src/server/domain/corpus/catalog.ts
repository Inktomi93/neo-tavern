import { sql } from "drizzle-orm";
import type { Db } from "../../../db/client";

// Distill-powered CATALOG analytics — what the 307 character_summaries unlock, all cheap SQL (no LLM).
// Answers "what do I actually have / hoard vs play" over the distilled genre/tone/tags. `json_each`
// unnests the tag arrays.

export interface CatalogStats {
  /** Collected (cards) vs played (total chats) per genre — what you hoard vs what you actually RP. */
  genres: { value: string; collected: number; played: number }[];
  tones: { value: string; collected: number; played: number }[];
  /** Most common distilled tags across the library. */
  topTags: { tag: string; count: number }[];
  /** Tags that co-occur on the same card (the "enemies-to-lovers also tagged NSFW" view). */
  tagPairs: { a: string; b: string; count: number }[];
  totals: { distilled: number; played: number };
}

export async function catalogStats(db: Db, ownerId: string): Promise<CatalogStats> {
  // collected (cards) + played (chats) per facet. The chat count is a correlated subquery per card,
  // summed by facet — cheap at ~300 cards.
  const facet = (col: "genre" | "tone") =>
    db.all<{ value: string; collected: number; played: number }>(sql`
      SELECT cs.${sql.raw(col)} AS value, COUNT(*) AS collected,
             COALESCE(SUM((
               SELECT COUNT(*) FROM chats ch
               JOIN character_versions v ON v.id = ch.character_version_id
               WHERE v.character_id = cs.character_id
             )), 0) AS played
      FROM character_summaries cs
      WHERE cs.owner_id = ${ownerId} AND cs.${sql.raw(col)} IS NOT NULL
      GROUP BY cs.${sql.raw(col)} ORDER BY collected DESC
    `);
  const [genres, tones] = await Promise.all([facet("genre"), facet("tone")]);

  // lower() merges the distill's case dups (e.g. "NSFW"/"nsfw") at read time.
  const topTags = await db.all<{ tag: string; count: number }>(sql`
    SELECT lower(je.value) AS tag, COUNT(*) AS count
    FROM character_summaries cs, json_each(cs.tags) je
    WHERE cs.owner_id = ${ownerId}
    GROUP BY lower(je.value) ORDER BY count DESC LIMIT 40
  `);

  const tagPairs = await db.all<{ a: string; b: string; count: number }>(sql`
    SELECT lower(a.value) AS a, lower(b.value) AS b, COUNT(*) AS count
    FROM character_summaries cs, json_each(cs.tags) a, json_each(cs.tags) b
    WHERE cs.owner_id = ${ownerId} AND lower(a.value) < lower(b.value)
    GROUP BY lower(a.value), lower(b.value) HAVING COUNT(*) >= 2 ORDER BY count DESC LIMIT 30
  `);

  const totals = (
    await db.all<{ distilled: number; played: number }>(sql`
      SELECT COUNT(*) AS distilled,
             (SELECT COUNT(*) FROM chats WHERE owner_id = ${ownerId}) AS played
      FROM character_summaries WHERE owner_id = ${ownerId}
    `)
  )[0] ?? { distilled: 0, played: 0 };

  return { genres, tones, topTags, tagPairs, totals };
}

export interface CharacterComparison {
  a: {
    characterId: string;
    name: string;
    genre: string | null;
    tone: string | null;
    pitch: string | null;
  };
  b: {
    characterId: string;
    name: string;
    genre: string | null;
    tone: string | null;
    pitch: string | null;
  };
  sameGenre: boolean;
  sameTone: boolean;
  sharedTags: string[];
  onlyA: string[];
  onlyB: string[];
  /** Tag Jaccard (|∩| / |∪|) — a cheap redundancy signal (card-curator's compare_cards, no LLM). */
  redundancy: number;
}

/** Compare two characters by their distilled facets — a free `compare_cards` (pairs with dedup). */
export async function compareCharacters(
  db: Db,
  ownerId: string,
  idA: string,
  idB: string,
): Promise<CharacterComparison | null> {
  const rows = await db.all<{
    characterId: string;
    name: string;
    genre: string | null;
    tone: string | null;
    pitch: string | null;
    tags: string | null;
  }>(sql`
    SELECT cs.character_id AS characterId, cv.name AS name, cs.genre AS genre, cs.tone AS tone,
           cs.elevator_pitch AS pitch, cs.tags AS tags
    FROM character_summaries cs
    JOIN characters c ON c.id = cs.character_id
    JOIN character_versions cv ON cv.id = c.current_version_id
    WHERE cs.owner_id = ${ownerId} AND cs.character_id IN (${idA}, ${idB})
  `);
  const ra = rows.find((r) => r.characterId === idA);
  const rb = rows.find((r) => r.characterId === idB);
  if (!ra || !rb) return null;
  const ta = new Set(parseTags(ra.tags));
  const tb = new Set(parseTags(rb.tags));
  const shared = [...ta].filter((t) => tb.has(t));
  const onlyA = [...ta].filter((t) => !tb.has(t));
  const onlyB = [...tb].filter((t) => !ta.has(t));
  const union = new Set([...ta, ...tb]).size;
  return {
    a: {
      characterId: ra.characterId,
      name: ra.name,
      genre: ra.genre,
      tone: ra.tone,
      pitch: ra.pitch,
    },
    b: {
      characterId: rb.characterId,
      name: rb.name,
      genre: rb.genre,
      tone: rb.tone,
      pitch: rb.pitch,
    },
    sameGenre: ra.genre !== null && ra.genre === rb.genre,
    sameTone: ra.tone !== null && ra.tone === rb.tone,
    sharedTags: shared,
    onlyA,
    onlyB,
    redundancy: union > 0 ? shared.length / union : 0,
  };
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
