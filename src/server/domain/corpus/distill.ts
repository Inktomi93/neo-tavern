import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterSummaries } from "../../../db/schema";
import type { Summarizer } from "../../embeddings/summarizer";
import { getLog } from "../../observability/logger";
import { collectEmbedTargets } from "./targets";

// Per-character DISTILLATION (card-curator classify_genre + summarize_card — B.0). A grammar-constrained
// LLM pass turns each character card into FILTERABLE facets (genre/tone from fixed vocabularies) + a
// one-line elevator pitch + a bounded overview, so a 300+ character library becomes skimmable and
// narrowable. The input is the card's stored embed text (character_embeddings.sourceText).

// Fixed vocabularies → enum-constrained in the grammar so the values are consistent enough to filter on.
export const GENRES = [
  "fantasy",
  "science-fiction",
  "modern",
  "historical",
  "horror",
  "romance",
  "slice-of-life",
  "adventure",
  "mystery",
  "comedy",
  "drama",
  "supernatural",
  "other",
] as const;

export const TONES = [
  "dark",
  "lighthearted",
  "romantic",
  "comedic",
  "gritty",
  "wholesome",
  "melancholic",
  "tense",
  "whimsical",
  "sensual",
] as const;

// Grammar-constrained output — same mechanism as DIGEST_SCHEMA. `enum` constrains genre/tone to the
// vocabularies above (GBNF can only emit a listed value); arrays are bounded; strings are length-capped
// by maxTokens. camelCase keys (biome) — the grammar constrains whatever keys we declare.
export const CHARACTER_DISTILL_SCHEMA = {
  type: "object",
  properties: {
    genre: { enum: [...GENRES] },
    subGenres: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 3 },
    tone: { enum: [...TONES] },
    setting: { type: "string" },
    tags: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 8 },
    elevatorPitch: { type: "string" },
    overview: { type: "string" },
  },
  required: ["genre", "subGenres", "tone", "setting", "tags", "elevatorPitch", "overview"],
};

const DISTILL_SYSTEM = `You distill a roleplay character card into a compact, FILTERABLE summary so a large library can be browsed at a glance.

Respond with ONLY a JSON object of this exact shape (no prose, no markdown, no <think>):
{"genre":"...","subGenres":["..."],"tone":"...","setting":"...","tags":["..."],"elevatorPitch":"...","overview":"..."}

- genre: the single best-fit primary genre (you will be constrained to a fixed list).
- subGenres: 0-3 secondary genres/modes.
- tone: the dominant tone (constrained to a fixed list).
- setting: a short phrase for the world/place ("modern urban fantasy", "feudal Japan").
- tags: 3-8 concrete, distinctive theme/content tags someone would filter by (not generic words).
- elevatorPitch: ONE sentence, broad strokes — who this character is and the hook.
- overview: 2-3 sentences — the character's premise, dynamic, and what RP with them is like. Concrete, no fluff.`;

const MAX_CARD_CHARS = 6000; // bound the prompt (cards run ~10k; the opening + persona carry the signal)

export interface DistillStats {
  distilled: number;
  failed: number;
}

interface DistillDeps {
  summarizer: Summarizer;
}

/**
 * Recompute every character's distillation from its CURRENT-version card text. Version-aware:
 * `collectEmbedTargets` resolves each character's `currentVersionId` (not whatever was last embedded),
 * so the stored `characterVersionId` always matches the current card — a version bump + re-run refreshes
 * it. Idempotent (upsert by characterId).
 */
export async function computeCharacterSummaries(db: Db, deps: DistillDeps): Promise<DistillStats> {
  const rows = await collectEmbedTargets(db); // current-version card text per character

  const now = Date.now();
  let distilled = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.text) continue;
    const card = r.text.slice(0, MAX_CARD_CHARS);
    const res = await deps.summarizer.summarize(DISTILL_SYSTEM, card, {
      jsonSchema: CHARACTER_DISTILL_SCHEMA,
      maxTokens: 512,
      temperature: 0.2,
    });
    const parsed = parseDistill(res.text);
    if (parsed === null) {
      failed += 1;
      continue;
    }
    const fields = {
      ownerId: r.ownerId,
      characterVersionId: r.characterVersionId,
      genre: parsed.genre,
      subGenres: parsed.subGenres,
      tone: parsed.tone,
      setting: parsed.setting,
      tags: parsed.tags,
      elevatorPitch: parsed.elevatorPitch,
      overview: parsed.overview,
      model: res.model,
      computedAt: now,
    };
    await db
      .insert(characterSummaries)
      .values({ characterId: r.characterId, ...fields })
      .onConflictDoUpdate({ target: characterSummaries.characterId, set: fields });
    distilled += 1;
  }
  const stats: DistillStats = { distilled, failed };
  getLog().info(stats, "corpus: character summaries distilled");
  return stats;
}

export interface CharacterDistillation {
  genre: string | null;
  subGenres: string[];
  tone: string | null;
  setting: string | null;
  tags: string[];
  elevatorPitch: string | null;
  overview: string | null;
}

export function parseDistill(raw: string): CharacterDistillation | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o: unknown = JSON.parse(raw.slice(start, end + 1));
    if (typeof o !== "object" || o === null) return null;
    const obj = o as {
      genre?: unknown;
      subGenres?: unknown;
      tone?: unknown;
      setting?: unknown;
      tags?: unknown;
      elevatorPitch?: unknown;
      overview?: unknown;
    };
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() ? v.trim() : null;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return {
      genre: str(obj.genre),
      subGenres: arr(obj.subGenres),
      tone: str(obj.tone),
      setting: str(obj.setting),
      tags: arr(obj.tags),
      elevatorPitch: str(obj.elevatorPitch),
      overview: str(obj.overview),
    };
  } catch {
    return null;
  }
}

// ── reads (live tRPC) ────────────────────────────────────────────────────────

/** One character's distillation (null if not yet computed). */
export async function characterSummary(
  db: Db,
  ownerId: string,
  characterId: string,
): Promise<CharacterDistillation | null> {
  const rows = await db
    .select()
    .from(characterSummaries)
    .where(
      and(eq(characterSummaries.ownerId, ownerId), eq(characterSummaries.characterId, characterId)),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    genre: r.genre,
    subGenres: jsonArr(r.subGenres),
    tone: r.tone,
    setting: r.setting,
    tags: jsonArr(r.tags),
    elevatorPitch: r.elevatorPitch,
    overview: r.overview,
  };
}

export interface BrowseCharacter {
  characterId: string;
  name: string;
  genre: string | null;
  tone: string | null;
  setting: string | null;
  tags: string[];
  elevatorPitch: string | null;
  chats: number;
  lastActive: number | null;
}

export interface BrowseFilter {
  genre?: string | undefined;
  tone?: string | undefined;
  tag?: string | undefined;
  q?: string | undefined; // free text over name + pitch + tags
  sort?: "chats" | "recent" | "name" | undefined;
  limit?: number | undefined;
}

/** The filterable character catalog — distillation facets + engagement. Filter/sort/limit run in SQL
 *  (owner+genre / owner+tone are indexed); only the matched page is materialized. */
export async function browseCharacters(
  db: Db,
  ownerId: string,
  filter: BrowseFilter = {},
): Promise<BrowseCharacter[]> {
  const conds = [sql`cs.owner_id = ${ownerId}`];
  if (filter.genre) conds.push(sql`cs.genre = ${filter.genre}`);
  if (filter.tone) conds.push(sql`cs.tone = ${filter.tone}`);
  if (filter.tag) conds.push(sql`lower(cs.tags) LIKE ${`%"${filter.tag.toLowerCase()}"%`}`);
  const q = filter.q?.trim().toLowerCase();
  if (q) {
    const like = `%${q}%`;
    conds.push(
      sql`(lower(cv.name) LIKE ${like} OR lower(cs.elevator_pitch) LIKE ${like} OR lower(cs.tags) LIKE ${like})`,
    );
  }
  const sort = filter.sort ?? "chats";
  let orderBy = sql`chats DESC`;
  if (sort === "name") orderBy = sql`cv.name ASC`;
  else if (sort === "recent") orderBy = sql`lastActive DESC`;

  const rows = await db.all<{
    characterId: string;
    name: string;
    genre: string | null;
    tone: string | null;
    setting: string | null;
    tags: string | null;
    elevatorPitch: string | null;
    chats: number;
    lastActive: number | null;
  }>(sql`
    SELECT cs.character_id AS characterId, cv.name AS name, cs.genre AS genre, cs.tone AS tone,
           cs.setting AS setting, cs.tags AS tags, cs.elevator_pitch AS elevatorPitch,
           (SELECT COUNT(*) FROM chats ch JOIN character_versions v2 ON v2.id = ch.character_version_id
              WHERE v2.character_id = cs.character_id) AS chats,
           (SELECT MAX(ch.created_at) FROM chats ch JOIN character_versions v2 ON v2.id = ch.character_version_id
              WHERE v2.character_id = cs.character_id) AS lastActive
    FROM character_summaries cs
    JOIN characters c ON c.id = cs.character_id
    JOIN character_versions cv ON cv.id = c.current_version_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY ${orderBy}
    LIMIT ${filter.limit ?? 200}
  `);

  return rows.map((r) => ({
    characterId: r.characterId,
    name: r.name,
    genre: r.genre,
    tone: r.tone,
    setting: r.setting,
    tags: jsonArr(r.tags),
    elevatorPitch: r.elevatorPitch,
    chats: r.chats,
    lastActive: r.lastActive,
  }));
}

/** Distinct genres/tones/tags present in the owner's distilled corpus — populates filter dropdowns. */
export async function characterFacets(
  db: Db,
  ownerId: string,
): Promise<{
  genres: { value: string; count: number }[];
  tones: { value: string; count: number }[];
}> {
  const genres = await db.all<{ value: string; count: number }>(sql`
    SELECT genre AS value, COUNT(*) AS count FROM character_summaries
    WHERE owner_id = ${ownerId} AND genre IS NOT NULL GROUP BY genre ORDER BY count DESC
  `);
  const tones = await db.all<{ value: string; count: number }>(sql`
    SELECT tone AS value, COUNT(*) AS count FROM character_summaries
    WHERE owner_id = ${ownerId} AND tone IS NOT NULL GROUP BY tone ORDER BY count DESC
  `);
  return { genres, tones };
}

// JSON `string[]` columns come back PARSED (an array) via drizzle's json codec but as a raw STRING via
// raw `sql`. Handle both.
function jsonArr(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string") {
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}
