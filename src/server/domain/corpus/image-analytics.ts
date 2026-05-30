import { eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characters, characterVersions, imageEmbeddings } from "../../../db/schema";
import { kmeans } from "./kmeans";

// Image-side analytics — the visual parallel to the text-card analytics, over the 306 SigLIP avatar
// embeddings (1152-dim, a SEPARATE space from the 1024-dim BGE-M3 text vectors). Reuses the same
// machinery (matmul / ANN kNN / k-means) — just on the image vectors. Answers "which cards share art",
// "what looks like this", and "what art styles do I collect".

interface AvatarRow {
  characterId: string;
  name: string;
  embedding: Float32Array;
}

/** Current-version avatar image vectors for the owner (one per character). */
async function loadAvatars(db: Db, ownerId: string): Promise<AvatarRow[]> {
  const rows = await db
    .select({
      characterId: characterVersions.characterId,
      name: characterVersions.name,
      embedding: imageEmbeddings.embedding,
    })
    .from(imageEmbeddings)
    .innerJoin(characterVersions, eq(characterVersions.avatarAssetId, imageEmbeddings.assetId))
    .innerJoin(characters, eq(characters.currentVersionId, characterVersions.id))
    .where(eq(characters.ownerId, ownerId));
  return rows.filter((r): r is AvatarRow => r.embedding !== null);
}

export interface ImageDuplicatePair {
  characterIdA: string;
  nameA: string;
  characterIdB: string;
  nameB: string;
  similarity: number;
}

/**
 * Cards sharing the same or near-identical ART (reused/duplicate avatars) — a visual cleanup signal the
 * text dedup can't see. Exact all-pairs cosine over the image vectors (306² is trivial). Threshold 0.92.
 */
export async function imageDuplicates(
  db: Db,
  ownerId: string,
  threshold = 0.92,
): Promise<ImageDuplicatePair[]> {
  const rows = await loadAvatars(db, ownerId);
  const n = rows.length;
  if (n < 2) return [];
  const dim = rows[0]?.embedding.length ?? 0;
  // L2-normalize once (normalized → dot = cosine).
  const flat = new Float32Array(n * dim);
  for (let i = 0; i < n; i += 1) {
    const v = rows[i]?.embedding ?? new Float32Array(dim);
    let norm = 0;
    for (let d = 0; d < dim; d += 1) norm += (v[d] ?? 0) ** 2;
    norm = Math.sqrt(norm) || 1;
    const base = i * dim;
    for (let d = 0; d < dim; d += 1) flat[base + d] = (v[d] ?? 0) / norm;
  }
  const out: ImageDuplicatePair[] = [];
  for (let i = 0; i < n; i += 1) {
    const bi = i * dim;
    for (let j = i + 1; j < n; j += 1) {
      const bj = j * dim;
      let cos = 0;
      for (let d = 0; d < dim; d += 1) cos += (flat[bi + d] ?? 0) * (flat[bj + d] ?? 0);
      if (cos < threshold) continue;
      const a = rows[i] as AvatarRow;
      const b = rows[j] as AvatarRow;
      out.push({
        characterIdA: a.characterId,
        nameA: a.name,
        characterIdB: b.characterId,
        nameB: b.name,
        similarity: cos,
      });
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity);
}

/** "What looks like this" — visually nearest characters by avatar (image→image ANN kNN, self excluded). */
export async function similarArt(
  db: Db,
  ownerId: string,
  characterId: string,
  limit = 10,
): Promise<{ characterId: string; name: string; similarity: number }[]> {
  const self = await db
    .select({ embedding: imageEmbeddings.embedding })
    .from(imageEmbeddings)
    .innerJoin(characterVersions, eq(characterVersions.avatarAssetId, imageEmbeddings.assetId))
    .innerJoin(characters, eq(characters.currentVersionId, characterVersions.id))
    .where(eq(characterVersions.characterId, characterId))
    .limit(1);
  const vec = self[0]?.embedding;
  if (!vec) return [];
  const query = JSON.stringify(Array.from(vec));
  const rows = await db.all<{ characterId: string; name: string; dist: number }>(sql`
    SELECT cv.character_id AS characterId, cv.name AS name,
           vector_distance_cos(ie.embedding, vector32(${query})) AS dist
    FROM vector_top_k('image_embeddings_ann', vector32(${query}), ${limit + 8}) AS v
    JOIN image_embeddings ie ON ie.rowid = v.id
    JOIN character_versions cv ON cv.avatar_asset_id = ie.asset_id
    JOIN characters c ON c.current_version_id = cv.id
    WHERE c.owner_id = ${ownerId} AND cv.character_id != ${characterId}
    ORDER BY dist ASC LIMIT ${limit}
  `);
  return rows.map((r) => ({ characterId: r.characterId, name: r.name, similarity: 1 - r.dist }));
}

export interface VisualArchetype {
  /** Dominant distilled genre/tone of the cluster's members (the art reads as…). */
  label: string;
  genre: string | null;
  tone: string | null;
  size: number;
  members: { characterId: string; name: string }[];
}

/** Art-style clusters — k-means over the avatar vectors, labeled by the members' dominant genre/tone. */
export async function visualArchetypes(db: Db, ownerId: string, k = 8): Promise<VisualArchetype[]> {
  const rows = await loadAvatars(db, ownerId);
  if (rows.length < k + 1) return [];
  const facets = await db.all<{
    characterId: string;
    genre: string | null;
    tone: string | null;
  }>(sql`
    SELECT character_id AS characterId, genre, tone FROM character_summaries WHERE owner_id = ${ownerId}
  `);
  const facetById = new Map(facets.map((f) => [f.characterId, f]));
  const km = kmeans(
    rows.map((r) => r.embedding),
    k,
    { seed: 1 },
  );
  const clusters = new Map<
    number,
    {
      members: { characterId: string; name: string }[];
      genre: Map<string, number>;
      tone: Map<string, number>;
    }
  >();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as AvatarRow;
    const c = km.assignments[i] ?? 0;
    let cl = clusters.get(c);
    if (cl === undefined) {
      cl = { members: [], genre: new Map(), tone: new Map() };
      clusters.set(c, cl);
    }
    cl.members.push({ characterId: row.characterId, name: row.name });
    const f = facetById.get(row.characterId);
    if (f?.genre) cl.genre.set(f.genre, (cl.genre.get(f.genre) ?? 0) + 1);
    if (f?.tone) cl.tone.set(f.tone, (cl.tone.get(f.tone) ?? 0) + 1);
  }
  const mode = (m: Map<string, number>): string | null =>
    [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const out: VisualArchetype[] = [];
  for (const cl of clusters.values()) {
    const genre = mode(cl.genre);
    const tone = mode(cl.tone);
    out.push({
      label: [tone, genre].filter(Boolean).join(" ") || "mixed",
      genre,
      tone,
      size: cl.members.length,
      members: cl.members.slice(0, 12),
    });
  }
  return out.sort((a, b) => b.size - a.size);
}
