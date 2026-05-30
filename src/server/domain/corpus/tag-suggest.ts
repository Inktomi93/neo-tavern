import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterTags, tags } from "../../../db/schema";
import { newId } from "../_shared/ids";

// Tag auto-suggest — promote the distilled `tags[]` into the real `tags` table (source='auto') so they
// become first-class, filterable, junction-linked tags. A REVIEW workflow: tagSuggestions() returns the
// candidates with the full per-tag character list (names included) so the user can pick which tags AND
// which characters; applyTags() writes exactly the chosen (tag → characters) assignments. The
// `tags.source='auto'` column exists for exactly this.

export interface TagSuggestion {
  tag: string;
  characterCount: number;
  /** Every character the tag would apply to — the user reviews/deselects per character. */
  characters: { characterId: string; name: string }[];
}

/**
 * Distilled tags not yet in the `tags` table, with their full candidate character list, for review.
 * `minCount` filters out one-off tags (default 2 — appears on ≥2 cards).
 */
export async function tagSuggestions(
  db: Db,
  ownerId: string,
  minCount = 2,
): Promise<TagSuggestion[]> {
  const rows = await db.all<{ characterId: string; name: string; tags: string | null }>(sql`
    SELECT cs.character_id AS characterId, cv.name AS name, cs.tags AS tags
    FROM character_summaries cs
    JOIN characters c ON c.id = cs.character_id
    JOIN character_versions cv ON cv.id = c.current_version_id
    WHERE cs.owner_id = ${ownerId}
  `);
  const existing = new Set(
    (
      await db.all<{ name: string }>(sql`
        SELECT lower(name) AS name FROM tags WHERE owner_id = ${ownerId}
      `)
    ).map((r) => r.name),
  );
  const byTag = new Map<string, { characterId: string; name: string }[]>();
  for (const r of rows) {
    for (const raw of parseTags(r.tags)) {
      const tag = raw.trim().toLowerCase();
      if (tag.length < 2 || existing.has(tag)) continue;
      const list = byTag.get(tag) ?? [];
      list.push({ characterId: r.characterId, name: r.name });
      byTag.set(tag, list);
    }
  }
  return [...byTag.entries()]
    .filter(([, chars]) => chars.length >= minCount)
    .map(([tag, characters]) => ({ tag, characterCount: characters.length, characters }))
    .sort((a, b) => b.characterCount - a.characterCount);
}

/** One reviewed assignment: a tag and the EXACT characters the user chose to apply it to. */
export interface TagAssignment {
  tag: string;
  characterIds: string[];
}

export interface ApplyTagsResult {
  tagsCreated: number;
  linksCreated: number;
}

/**
 * Apply the reviewed assignments: for each, reuse-or-create the tag (source='auto') and link exactly the
 * chosen characters. Idempotent (existing links are skipped), so re-applying is safe. Owner-scoped:
 * characterIds are validated against the owner's distilled cards, so a forged id can't link.
 */
export async function applyTagSuggestions(
  db: Db,
  ownerId: string,
  assignments: readonly TagAssignment[],
): Promise<ApplyTagsResult> {
  // The owner's valid (characterId, distilled-tag) pairs — the authorization + truth source. An
  // assignment can only link a character to a tag the distillation actually produced for it.
  const ownerRows = await db.all<{ characterId: string; tags: string | null }>(sql`
    SELECT character_id AS characterId, tags FROM character_summaries WHERE owner_id = ${ownerId}
  `);
  const validTagsByChar = new Map<string, Set<string>>();
  for (const r of ownerRows) {
    validTagsByChar.set(
      r.characterId,
      new Set(parseTags(r.tags).map((t) => t.trim().toLowerCase())),
    );
  }

  let tagsCreated = 0;
  let linksCreated = 0;
  for (const asn of assignments) {
    const tag = asn.tag.trim().toLowerCase();
    if (tag.length < 2) continue;
    const characterIds = [...new Set(asn.characterIds)].filter((cid) =>
      validTagsByChar.get(cid)?.has(tag),
    );
    if (characterIds.length === 0) continue;

    const found = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.ownerId, ownerId), sql`lower(${tags.name}) = ${tag}`))
      .limit(1);
    let tagId = found[0]?.id;
    if (tagId === undefined) {
      tagId = newId();
      await db.insert(tags).values({ id: tagId, ownerId, name: tag, source: "auto" });
      tagsCreated += 1;
    }
    for (const characterId of characterIds) {
      const res = await db
        .insert(characterTags)
        .values({ tagId, characterId })
        .onConflictDoNothing();
      linksCreated += res.rowsAffected ?? 0;
    }
  }
  return { tagsCreated, linksCreated };
}

/** Tags already auto-applied (source='auto') with their link counts — so review can show current state. */
export async function appliedAutoTags(
  db: Db,
  ownerId: string,
): Promise<{ tag: string; characterCount: number }[]> {
  return db.all<{ tag: string; characterCount: number }>(sql`
    SELECT t.name AS tag, COUNT(ct.character_id) AS characterCount
    FROM tags t LEFT JOIN character_tags ct ON ct.tag_id = t.id
    WHERE t.owner_id = ${ownerId} AND t.source = 'auto'
    GROUP BY t.id ORDER BY characterCount DESC
  `);
}

/** Undo an auto-applied tag entirely (delete the tag + its links). Only `source='auto'` tags. */
export async function removeAutoTag(db: Db, ownerId: string, tag: string): Promise<boolean> {
  const norm = tag.trim().toLowerCase();
  const found = await db
    .select({ id: tags.id })
    .from(tags)
    .where(
      and(eq(tags.ownerId, ownerId), eq(tags.source, "auto"), sql`lower(${tags.name}) = ${norm}`),
    )
    .limit(1);
  const id = found[0]?.id;
  if (id === undefined) return false;
  await db.delete(characterTags).where(inArray(characterTags.tagId, [id]));
  await db.delete(tags).where(eq(tags.id, id));
  return true;
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
