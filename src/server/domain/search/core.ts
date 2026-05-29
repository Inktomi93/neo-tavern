import { sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import type { Embedder } from "../../embeddings/embedder";
import { getLog } from "../../observability/logger";
import {
  type Candidate,
  CSLS_POOL_FACTOR,
  DISCOVER_SEGMENT_POOL_CAP,
  DISCOVER_SEGMENT_POOL_FACTOR,
  DISCOVER_SEGMENTS_PER_CHAR,
  OWNER_OVERFETCH,
  SNIPPET_CHARS,
} from "./constants";
import type { createSearchInternal } from "./internal";
import type { DiscoverCharacter, DiscoverSegment, FindResult, SearchHit } from "./types";

export function createSearchCore(
  db: Db,
  embedder: Embedder,
  internal: ReturnType<typeof createSearchInternal>,
) {
  const { applyRerank, resolveCharacterDisplay, resolveSegmentDisplay } = internal;
  async function knn(params: {
    queryText: string;
    k?: number | undefined;
    ownerId?: string | undefined;
    rerank?: boolean | undefined;
  }): Promise<SearchHit[]> {
    const { queryText, k = 10, ownerId, rerank = false } = params;
    const embedding = await embedder.embed(queryText);
    const query = JSON.stringify(Array.from(embedding));
    // Pool ≥ k for the CSLS re-rank + the rerank candidate set; unioned with owner over-fetch.
    const poolK = Math.max(k * CSLS_POOL_FACTOR, ownerId ? k * OWNER_OVERFETCH : k);
    // Two ANN queries unioned into one CSLS-ranked pool: characters from character_embeddings,
    // segments from chat_segments. BOTH carry a denormalized owner_id, so scope is a direct WHERE
    // on the joined row (the old polymorphic over-fetch + scopeToOwner join-back is retired).
    const ownerFilter = (col: string) =>
      ownerId ? sql`WHERE ${sql.raw(col)} = ${ownerId}` : sql``;
    const charRows = await db.all<{
      entityId: string;
      dist: number;
      hubScore: number | null;
      sourceText: string | null;
    }>(sql`
      SELECT ce.character_id AS entityId,
             vector_distance_cos(ce.embedding, vector32(${query})) AS dist,
             ce.hub_score AS hubScore, ce.source_text AS sourceText
      FROM vector_top_k('character_embeddings_ann', vector32(${query}), ${poolK}) AS v
      JOIN character_embeddings ce ON ce.rowid = v.id
      ${ownerFilter("ce.owner_id")}
      ORDER BY dist ASC
    `);
    const segRows = await db.all<{
      id: string;
      chatId: string;
      blockIdx: number;
      dist: number;
      hubScore: number | null;
      text: string;
    }>(sql`
      SELECT cs.id AS id, cs.chat_id AS chatId, cs.block_idx AS blockIdx,
             vector_distance_cos(cs.embedding, vector32(${query})) AS dist,
             cs.hub_score AS hubScore, cs.text AS text
      FROM vector_top_k('chat_segments_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_segments cs ON cs.rowid = v.id
      ${ownerFilter("cs.owner_id")}
      ORDER BY dist ASC
    `);
    // CSLS hubness correction: adjusted = max(0, dist - 1 + hub_score), demoting near-everything
    // vectors. null hub_score → raw distance. Stable sort keeps the raw-distance tiebreak.
    const csls = (dist: number, hub: number | null): number =>
      hub === null ? dist : Math.max(0, dist - 1 + hub);
    const scored = [
      ...charRows.map((r) => ({
        cand: {
          entityType: "character",
          entityId: r.entityId,
          distance: r.dist,
          sourceText: r.sourceText,
        },
        rank: csls(r.dist, r.hubScore),
      })),
      ...segRows.map((r) => ({
        cand: {
          entityType: "chat_segment",
          entityId: r.id,
          distance: r.dist,
          sourceText: r.text,
        },
        rank: csls(r.dist, r.hubScore),
      })),
    ];
    scored.sort((a, b) => a.rank - b.rank);
    const pool = scored.map((a) => a.cand);
    // Owner scoping now lives in the SQL (direct owner_id WHERE), so the pool is already scoped.
    const ranked = rerank ? await applyRerank(queryText, pool) : pool;
    const hits: SearchHit[] = ranked
      .slice(0, k)
      .map((c) => ({ entityType: c.entityType, entityId: c.entityId, distance: c.distance }));
    getLog().debug(
      {
        k,
        ownerScoped: ownerId !== undefined,
        reranked: rerank,
        fetched: pool.length,
        hits: hits.length,
      },
      "search: knn",
    );
    return hits;
  }

  async function find(params: {
    queryText: string;
    k?: number | undefined;
    ownerId?: string | undefined;
    rerank?: boolean | undefined;
  }): Promise<FindResult[]> {
    const hits = await knn(params); // already CSLS/rerank-ordered + owner-scoped
    const charIds = hits.filter((h) => h.entityType === "character").map((h) => h.entityId);
    const segIds = hits.filter((h) => h.entityType === "chat_segment").map((h) => h.entityId);
    const [charMap, segMap] = await Promise.all([
      resolveCharacterDisplay(charIds),
      resolveSegmentDisplay(segIds),
    ]);
    const results: FindResult[] = [];
    for (const h of hits) {
      if (h.entityType === "character") {
        const c = charMap.get(h.entityId);
        if (c) {
          results.push({
            kind: "character",
            entityId: h.entityId,
            distance: h.distance,
            name: c.name,
            tags: c.tags,
          });
        }
      } else if (h.entityType === "chat_segment") {
        const s = segMap.get(h.entityId);
        if (s) {
          results.push({
            kind: "segment",
            entityId: h.entityId,
            distance: h.distance,
            characterName: s.name,
            chatId: s.chatId,
            segIndex: s.segIndex,
            snippet: s.snippet,
          });
        }
      }
    }
    getLog().debug(
      { results: results.length, characters: charIds.length, segments: segIds.length },
      "search: find (enriched)",
    );
    return results;
  }

  async function discover(params: {
    queryText: string;
    k?: number | undefined;
    ownerId?: string | undefined;
    rerank?: boolean | undefined;
  }): Promise<DiscoverCharacter[]> {
    const { queryText, k = 10, ownerId, rerank = false } = params;
    const embedding = await embedder.embed(queryText);
    const query = JSON.stringify(Array.from(embedding));
    const poolK = Math.min(k * DISCOVER_SEGMENT_POOL_FACTOR, DISCOVER_SEGMENT_POOL_CAP);
    // Segment pool from the first-class chat_segments table (Phase B), CSLS-rankable + rerankable.
    const rows = await db.all<{
      id: string;
      chatId: string;
      blockIdx: number;
      dist: number;
      hubScore: number | null;
      text: string;
    }>(sql`
      SELECT cs.id AS id, cs.chat_id AS chatId, cs.block_idx AS blockIdx,
             vector_distance_cos(cs.embedding, vector32(${query})) AS dist,
             cs.hub_score AS hubScore, cs.text AS text
      FROM vector_top_k('chat_segments_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_segments cs ON cs.rowid = v.id
      ORDER BY dist ASC
    `);
    const pool: Candidate[] = rows
      .map((row) => ({
        cand: {
          entityType: "chat_segment",
          entityId: row.id,
          distance: row.dist,
          sourceText: row.text,
        },
        rank: row.hubScore === null ? row.dist : Math.max(0, row.dist - 1 + row.hubScore),
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.cand);
    // Rerank the SEGMENTS (independent of grouping) before grouping — a segment the reranker
    // promotes can pull in a character CSLS ranked low.
    const ranked = rerank ? await applyRerank(queryText, pool) : pool;

    const display = await resolveSegmentDisplay(
      ranked.map((c) => c.entityId),
      ownerId,
    );
    // Group by character in ranked order — first appearance = best segment. Map preserves
    // insertion order, so iterating values() yields characters already ranked by best match.
    const byChar = new Map<string, DiscoverCharacter>();
    for (const c of ranked) {
      const d = display.get(c.entityId);
      if (!d) continue; // chat not owned / unresolved → dropped
      const seg: DiscoverSegment = {
        chatId: d.chatId,
        segIndex: d.segIndex,
        snippet: (c.sourceText ?? "").slice(0, SNIPPET_CHARS),
        distance: c.distance,
      };
      const existing = byChar.get(d.characterId);
      if (existing) {
        existing.matchCount += 1;
        if (existing.segments.length < DISCOVER_SEGMENTS_PER_CHAR) existing.segments.push(seg);
      } else {
        byChar.set(d.characterId, {
          characterId: d.characterId,
          name: d.name,
          tags: d.tags,
          description: d.description,
          avatarHash: d.avatarHash,
          matchCount: 1,
          bestDistance: c.distance,
          segments: [seg],
        });
      }
    }
    const result = [...byChar.values()].slice(0, k);
    getLog().debug(
      { k, reranked: rerank, pool: ranked.length, characters: result.length },
      "search: discover",
    );
    return result;
  }

  // Cross-chat corpus search over the DIGEST substrate. chat_digests HAS owner_id, so scoping is a
  // WHERE (no post-fetch ownership resolve like the polymorphic embeddings path). Digest hub scores
  // aren't computed yet, so CSLS is null-safe / raw distance today; the rerank still sharpens order.
  return { knn, find, discover };
}
