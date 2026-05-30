import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterEmbeddings, characterVersions, chatSegments, chats } from "../../../db/schema";
import { pairsAboveThreshold } from "./duplicates";
import { cosineDistance } from "./kmeans";

// "Explore my corpus" surface (docs/planning/breadth-buildout.md B.6): a character SIMILARITY GRAPH
// (low-threshold pairwise cosine → nodes+edges for a force-directed view) and "more like THIS chat"
// (chat-centroid kNN). Centroid cosine is the RIGHT tool here — we want semantic closeness ("similar
// vibe"), which is exactly what a centroid captures; the dedup pillar avoided it only because for
// DUPLICATE detection it conflates same-character with same-chat (B.5). Live compute (no rollup): the
// exact matmul is tens of ms at corpus scale (B.7).

const DIM = 1024;

export interface SimilarityGraph {
  nodes: { characterId: string; name: string; degree: number }[];
  edges: { source: string; target: string; similarity: number }[];
}

/**
 * Character similarity graph — every character pair with cosine ≥ `minSimilarity` is an edge. Nodes are
 * capped to the `maxNodes` highest-degree characters (the dense core); edges are filtered to kept nodes.
 */
export async function characterSimilarityGraph(
  db: Db,
  ownerId: string,
  opts: { minSimilarity?: number | undefined; maxNodes?: number | undefined } = {},
): Promise<SimilarityGraph> {
  const minSimilarity = opts.minSimilarity ?? 0.65;
  const maxNodes = opts.maxNodes ?? 120;

  const rows = await db
    .select({
      characterId: characterEmbeddings.characterId,
      embedding: characterEmbeddings.embedding,
      hubScore: characterEmbeddings.hubScore,
    })
    .from(characterEmbeddings)
    .where(eq(characterEmbeddings.ownerId, ownerId));
  const withVec = rows.filter(
    (r): r is typeof r & { embedding: Float32Array } => r.embedding !== null,
  );
  if (withVec.length === 0) return { nodes: [], edges: [] };

  const hubs = new Map<string, number>();
  for (const r of withVec) if (r.hubScore != null) hubs.set(r.characterId, r.hubScore);
  const pairs = pairsAboveThreshold(
    withVec.map((r) => r.characterId),
    withVec.map((r) => r.embedding),
    hubs,
    minSimilarity,
  );

  // Degree per character, then keep the top-`maxNodes` by degree.
  const degree = new Map<string, number>();
  for (const p of pairs) {
    degree.set(p.idA, (degree.get(p.idA) ?? 0) + 1);
    degree.set(p.idB, (degree.get(p.idB) ?? 0) + 1);
  }
  const kept = new Set(
    [...degree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxNodes)
      .map(([id]) => id),
  );
  const edges = pairs
    .filter((p) => kept.has(p.idA) && kept.has(p.idB))
    .map((p) => ({ source: p.idA, target: p.idB, similarity: p.cosine }));

  const names = await characterNames(db, [...kept]);
  const nodes = [...kept].map((id) => ({
    characterId: id,
    name: names.get(id) ?? "Unknown",
    degree: degree.get(id) ?? 0,
  }));
  return { nodes, edges };
}

export interface SimilarChat {
  chatId: string;
  title: string | null;
  characterName: string;
  similarity: number;
}

/** "More like this chat" — k nearest chats by segment-centroid cosine, owner-scoped, self excluded. */
export async function similarChats(
  db: Db,
  ownerId: string,
  chatId: string,
  limit = 10,
): Promise<SimilarChat[]> {
  const segs = await db
    .select({
      chatId: chatSegments.chatId,
      embedding: chatSegments.embedding,
    })
    .from(chatSegments)
    .where(eq(chatSegments.ownerId, ownerId));

  const centroids = new Map<string, { sum: Float32Array; n: number }>();
  for (const s of segs) {
    if (!s.embedding) continue;
    let c = centroids.get(s.chatId);
    if (c === undefined) {
      c = { sum: new Float32Array(DIM), n: 0 };
      centroids.set(s.chatId, c);
    }
    for (let d = 0; d < DIM; d += 1) c.sum[d] = (c.sum[d] ?? 0) + (s.embedding[d] ?? 0);
    c.n += 1;
  }
  const mean = (c: { sum: Float32Array; n: number }): Float32Array => {
    const m = new Float32Array(DIM);
    for (let d = 0; d < DIM; d += 1) m[d] = (c.sum[d] ?? 0) / c.n;
    return m;
  };
  const target = centroids.get(chatId);
  if (target === undefined || target.n === 0) return [];
  const tv = mean(target);

  const scored: { chatId: string; similarity: number }[] = [];
  for (const [id, c] of centroids) {
    if (id === chatId || c.n === 0) continue;
    scored.push({ chatId: id, similarity: 1 - cosineDistance(tv, mean(c)) });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, limit);

  // Resolve title + character name for the top hits.
  const ids = top.map((t) => t.chatId);
  if (ids.length === 0) return [];
  const meta = await db
    .select({ id: chats.id, title: chats.title, name: characterVersions.name })
    .from(chats)
    .innerJoin(characterVersions, eq(characterVersions.id, chats.characterVersionId))
    .where(inArray(chats.id, ids));
  const metaById = new Map(meta.map((m) => [m.id, m]));
  return top.map((t) => ({
    chatId: t.chatId,
    title: metaById.get(t.chatId)?.title ?? null,
    characterName: metaById.get(t.chatId)?.name ?? "Unknown",
    similarity: t.similarity,
  }));
}

async function characterNames(db: Db, characterIds: string[]): Promise<Map<string, string>> {
  if (characterIds.length === 0) return new Map();
  const rows = await db.all<{ characterId: string; name: string }>(sql`
    SELECT character_id AS characterId, name FROM character_versions
    WHERE character_id IN (${sql.join(
      characterIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.characterId)) out.set(r.characterId, r.name);
  return out;
}
