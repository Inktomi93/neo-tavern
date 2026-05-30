import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterTags, tags } from "../../../db/schema";
import { newId } from "../_shared/ids";

// Tag auto-suggest — promote the distilled `tags[]` into the real `tags` table (source='auto') so they
// become first-class, filterable, junction-linked tags. tagSuggestions() is a read (review); applyTags()
// is the write (confirm-then-apply). The `tags.source='auto'` column exists for exactly this.

export interface TagSuggestion {
  tag: string;
  characterCount: number;
  sampleCharacterIds: string[];
}

/** Distilled tags not yet in the `tags` table, as promotion candidates (≥2 characters), most-common first. */
export async function tagSuggestions(db: Db, ownerId: string): Promise<TagSuggestion[]> {
  const rows = await db.all<{ characterId: string; tags: string | null }>(sql`
    SELECT character_id AS characterId, tags FROM character_summaries WHERE owner_id = ${ownerId}
  `);
  const existing = new Set(
    (
      await db.all<{ name: string }>(sql`
        SELECT lower(name) AS name FROM tags WHERE owner_id = ${ownerId}
      `)
    ).map((r) => r.name),
  );
  const byTag = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const raw of parseTags(r.tags)) {
      const tag = raw.trim().toLowerCase();
      if (tag.length < 2) continue;
      let set = byTag.get(tag);
      if (set === undefined) {
        set = new Set();
        byTag.set(tag, set);
      }
      set.add(r.characterId);
    }
  }
  return [...byTag.entries()]
    .filter(([tag, ids]) => ids.size >= 2 && !existing.has(tag))
    .map(([tag, ids]) => ({
      tag,
      characterCount: ids.size,
      sampleCharacterIds: [...ids].slice(0, 10),
    }))
    .sort((a, b) => b.characterCount - a.characterCount)
    .slice(0, 80);
}

export interface ApplyTagsResult {
  tagsCreated: number;
  linksCreated: number;
}

/** Promote the approved distilled tags: create each as a `source='auto'` tag and link its characters. */
export async function applyTagSuggestions(
  db: Db,
  ownerId: string,
  tagNames: readonly string[],
): Promise<ApplyTagsResult> {
  const approved = new Set(
    tagNames.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2),
  );
  if (approved.size === 0) return { tagsCreated: 0, linksCreated: 0 };

  // Resolve which characters carry each approved tag (from the distillation).
  const rows = await db.all<{ characterId: string; tags: string | null }>(sql`
    SELECT character_id AS characterId, tags FROM character_summaries WHERE owner_id = ${ownerId}
  `);
  const members = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const raw of parseTags(r.tags)) {
      const tag = raw.trim().toLowerCase();
      if (!approved.has(tag)) continue;
      let set = members.get(tag);
      if (set === undefined) {
        set = new Set();
        members.set(tag, set);
      }
      set.add(r.characterId);
    }
  }

  let tagsCreated = 0;
  let linksCreated = 0;
  for (const [tag, characterIds] of members) {
    // Reuse an existing tag of this name (manual or auto), else create an auto one.
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

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
