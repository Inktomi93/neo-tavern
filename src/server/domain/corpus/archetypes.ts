import { eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterEmbeddings } from "../../../db/schema";
import { kmeans } from "./kmeans";

// Character ARCHETYPES — cluster the character CARD embeddings (not chats) to surface the kinds of
// characters you collect ("the broken healer", "the dominant queen"), then label each cluster cheaply
// from the distilled facets (dominant genre/tone + top tags — no LLM). The character-side analog of
// themes; answers "what kinds of characters do I have" over 300+ cards. Live compute (~296 vectors).

export interface Archetype {
  /** Composed label from the dominant facets, e.g. "dark fantasy". */
  label: string;
  genre: string | null;
  tone: string | null;
  topTags: string[];
  size: number;
  members: { characterId: string; name: string }[];
}

export async function characterArchetypes(db: Db, ownerId: string, k = 10): Promise<Archetype[]> {
  const embRows = await db
    .select({
      characterId: characterEmbeddings.characterId,
      embedding: characterEmbeddings.embedding,
    })
    .from(characterEmbeddings)
    .where(eq(characterEmbeddings.ownerId, ownerId));
  const withVec = embRows.filter(
    (r): r is typeof r & { embedding: Float32Array } => r.embedding !== null,
  );
  if (withVec.length < k + 1) return [];

  // Facets + names, joined in-process by characterId.
  const facetRows = await db.all<{
    characterId: string;
    name: string;
    genre: string | null;
    tone: string | null;
    tags: string | null;
  }>(sql`
    SELECT cs.character_id AS characterId, cv.name AS name, cs.genre AS genre, cs.tone AS tone,
           cs.tags AS tags
    FROM character_summaries cs
    JOIN characters c ON c.id = cs.character_id
    JOIN character_versions cv ON cv.id = c.current_version_id
    WHERE cs.owner_id = ${ownerId}
  `);
  const facetById = new Map(facetRows.map((r) => [r.characterId, r]));

  const km = kmeans(
    withVec.map((r) => r.embedding),
    k,
    { seed: 1 },
  );

  // Gather members + facet tallies per cluster.
  const clusters = new Map<
    number,
    {
      members: { characterId: string; name: string }[];
      genre: Map<string, number>;
      tone: Map<string, number>;
      tags: Map<string, number>;
    }
  >();
  for (let i = 0; i < withVec.length; i += 1) {
    const cid = withVec[i]?.characterId ?? "";
    const c = km.assignments[i] ?? 0;
    let cl = clusters.get(c);
    if (cl === undefined) {
      cl = { members: [], genre: new Map(), tone: new Map(), tags: new Map() };
      clusters.set(c, cl);
    }
    const f = facetById.get(cid);
    cl.members.push({ characterId: cid, name: f?.name ?? "Unknown" });
    if (f?.genre) cl.genre.set(f.genre, (cl.genre.get(f.genre) ?? 0) + 1);
    if (f?.tone) cl.tone.set(f.tone, (cl.tone.get(f.tone) ?? 0) + 1);
    for (const t of parseTags(f?.tags ?? null)) {
      const key = t.toLowerCase();
      cl.tags.set(key, (cl.tags.get(key) ?? 0) + 1);
    }
  }

  const mode = (m: Map<string, number>): string | null =>
    [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const top = (m: Map<string, number>, n: number): string[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([t]) => t);

  const out: Archetype[] = [];
  for (const cl of clusters.values()) {
    const genre = mode(cl.genre);
    const tone = mode(cl.tone);
    out.push({
      label: [tone, genre].filter(Boolean).join(" ") || "mixed",
      genre,
      tone,
      topTags: top(cl.tags, 5),
      size: cl.members.length,
      members: cl.members.slice(0, 12),
    });
  }
  return out.sort((a, b) => b.size - a.size);
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
