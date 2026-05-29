import { inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterVersions } from "../../../db/schema";
import type { Embedder } from "../../embeddings/embedder";
import type { Reranker } from "../../embeddings/reranker";
import { getLog } from "../../observability/logger";
import { ensureUser } from "../_shared/users";
import { CSLS_POOL_FACTOR, OWNER_OVERFETCH, SNIPPET_CHARS } from "./constants";
import type { CorpusHit, DigestSearchHit, SegmentSearchHit } from "./types";

export function createSearchMemory(db: Db, embedder: Embedder, reranker: Reranker) {
  async function digests(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<DigestSearchHit[]> {
    const { queryText, k = 10, rerank = false } = params;
    const ownerId = await ensureUser(db, params.username);
    const embedding = await embedder.embed(queryText);
    const query = JSON.stringify(Array.from(embedding));
    const poolK = Math.max(k * CSLS_POOL_FACTOR, k * OWNER_OVERFETCH);
    const rows = await db.all<{
      chatId: string;
      characterVersionId: string;
      tier: number;
      blockIdx: number;
      seqStart: number;
      seqEnd: number;
      topicAnchor: string | null;
      text: string;
      dist: number;
      hubScore: number | null;
    }>(sql`
      SELECT cd.chat_id AS chatId, cd.character_version_id AS characterVersionId,
             cd.tier AS tier, cd.block_idx AS blockIdx,
             cd.seq_start AS seqStart, cd.seq_end AS seqEnd,
             cd.topic_anchor AS topicAnchor, cd.text AS text,
             vector_distance_cos(cd.embedding, vector32(${query})) AS dist,
             cd.hub_score AS hubScore
      FROM vector_top_k('chat_digests_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_digests cd ON cd.rowid = v.id
      WHERE cd.owner_id = ${ownerId}
      ORDER BY dist ASC
    `);
    // CSLS hubness correction (same formula as knn; null hub_score → raw distance).
    const adjusted = rows.map((row) => ({
      row,
      rank: row.hubScore === null ? row.dist : Math.max(0, row.dist - 1 + row.hubScore),
    }));
    adjusted.sort((a, b) => a.rank - b.rank);
    let pool = adjusted.map((a) => a.row);
    const idOf = (r: (typeof pool)[number]): string => `${r.chatId}:${r.tier}:${r.blockIdx}`;
    if (rerank && pool.length > 0) {
      const scores = await reranker.rerank(
        queryText,
        pool.map((r) => ({ id: idOf(r), text: r.text })),
      );
      const order = new Map(scores.map((s, i) => [s.id, i]));
      pool = [...pool].sort(
        (a, b) =>
          (order.get(idOf(a)) ?? Number.POSITIVE_INFINITY) -
          (order.get(idOf(b)) ?? Number.POSITIVE_INFINITY),
      );
    }

    const cvIds = [...new Set(pool.map((r) => r.characterVersionId))];
    const cvMap = new Map<string, string>();
    if (cvIds.length > 0) {
      const cvRows = await db
        .select({ id: characterVersions.id, name: characterVersions.name })
        .from(characterVersions)
        .where(inArray(characterVersions.id, cvIds));
      for (const row of cvRows) cvMap.set(row.id, row.name);
    }

    const hits: DigestSearchHit[] = pool.slice(0, k).map((r) => ({
      chatId: r.chatId,
      characterVersionId: r.characterVersionId,
      characterName: cvMap.get(r.characterVersionId) ?? "Unknown",
      tier: r.tier,
      blockIdx: r.blockIdx,
      seqStart: r.seqStart,
      seqEnd: r.seqEnd,
      topicAnchor: r.topicAnchor,
      snippet: r.text.slice(0, SNIPPET_CHARS),
      distance: r.dist,
    }));
    getLog().debug(
      { k, reranked: rerank, fetched: pool.length, hits: hits.length },
      "search: digests",
    );
    return hits;
  }

  // Cross-chat search over the raw SEGMENT substrate — the verbatim half of the hybrid. Mirrors
  // digests(): owner-scoped WHERE (chat_segments has owner_id), CSLS-null-safe, optional rerank.
  async function segments(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<SegmentSearchHit[]> {
    const { queryText, k = 10, rerank = false } = params;
    const ownerId = await ensureUser(db, params.username);
    const embedding = await embedder.embed(queryText);
    const query = JSON.stringify(Array.from(embedding));
    const poolK = Math.max(k * CSLS_POOL_FACTOR, k * OWNER_OVERFETCH);
    const rows = await db.all<{
      chatId: string;
      characterVersionId: string;
      blockIdx: number;
      seqStart: number;
      seqEnd: number;
      text: string;
      dist: number;
      hubScore: number | null;
    }>(sql`
      SELECT cs.chat_id AS chatId, cs.character_version_id AS characterVersionId,
             cs.block_idx AS blockIdx, cs.seq_start AS seqStart, cs.seq_end AS seqEnd, cs.text AS text,
             vector_distance_cos(cs.embedding, vector32(${query})) AS dist,
             cs.hub_score AS hubScore
      FROM vector_top_k('chat_segments_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_segments cs ON cs.rowid = v.id
      WHERE cs.owner_id = ${ownerId}
      ORDER BY dist ASC
    `);
    const adjusted = rows.map((row) => ({
      row,
      rank: row.hubScore === null ? row.dist : Math.max(0, row.dist - 1 + row.hubScore),
    }));
    adjusted.sort((a, b) => a.rank - b.rank);
    let pool = adjusted.map((a) => a.row);
    const idOf = (r: (typeof pool)[number]): string => `${r.chatId}:${r.blockIdx}`;
    if (rerank && pool.length > 0) {
      const scores = await reranker.rerank(
        queryText,
        pool.map((r) => ({ id: idOf(r), text: r.text })),
      );
      const order = new Map(scores.map((s, i) => [s.id, i]));
      pool = [...pool].sort(
        (a, b) =>
          (order.get(idOf(a)) ?? Number.POSITIVE_INFINITY) -
          (order.get(idOf(b)) ?? Number.POSITIVE_INFINITY),
      );
    }

    const cvIds = [...new Set(pool.map((r) => r.characterVersionId))];
    const cvMap = new Map<string, string>();
    if (cvIds.length > 0) {
      const cvRows = await db
        .select({ id: characterVersions.id, name: characterVersions.name })
        .from(characterVersions)
        .where(inArray(characterVersions.id, cvIds));
      for (const row of cvRows) cvMap.set(row.id, row.name);
    }

    const hits: SegmentSearchHit[] = pool.slice(0, k).map((r) => ({
      chatId: r.chatId,
      characterVersionId: r.characterVersionId,
      characterName: cvMap.get(r.characterVersionId) ?? "Unknown",
      blockIdx: r.blockIdx,
      seqStart: r.seqStart,
      seqEnd: r.seqEnd,
      snippet: r.text.slice(0, SNIPPET_CHARS),
      distance: r.dist,
    }));
    getLog().debug(
      { k, reranked: rerank, fetched: pool.length, hits: hits.length },
      "search: segments",
    );
    return hits;
  }

  // The hybrid "mix" as a UNIFIED single ranked list: pool candidates from BOTH substrates
  // (digests = theme/precision, segments = verbatim), owner-scoped; rank the COMBINED pool by a
  // joint cross-encoder rerank over full text (the unifier across the two lenses — or CSLS-adjusted
  // distance when rerank is off, comparable since both are cosine); dedupe per block, keeping the
  // better-ranked lens; cap at k. Hits carry the seq span for verbatim click-through.
  async function corpus(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<CorpusHit[]> {
    const { queryText, k = 10, rerank = true } = params;
    const ownerId = await ensureUser(db, params.username);
    const embedding = await embedder.embed(queryText);
    const query = JSON.stringify(Array.from(embedding));
    const poolK = Math.max(k * CSLS_POOL_FACTOR, k * OWNER_OVERFETCH);
    const digRows = await db.all<{
      chatId: string;
      characterVersionId: string;
      tier: number;
      blockIdx: number;
      seqStart: number;
      seqEnd: number;
      text: string;
      dist: number;
      hubScore: number | null;
      topicAnchor: string | null;
    }>(sql`
      SELECT cd.chat_id AS chatId, cd.character_version_id AS characterVersionId, cd.tier AS tier,
             cd.block_idx AS blockIdx, cd.seq_start AS seqStart, cd.seq_end AS seqEnd, cd.text AS text,
             vector_distance_cos(cd.embedding, vector32(${query})) AS dist, cd.hub_score AS hubScore,
             cd.topic_anchor AS topicAnchor
      FROM vector_top_k('chat_digests_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_digests cd ON cd.rowid = v.id
      WHERE cd.owner_id = ${ownerId}
      ORDER BY dist ASC
    `);
    const segRows = await db.all<{
      chatId: string;
      characterVersionId: string;
      blockIdx: number;
      seqStart: number;
      seqEnd: number;
      text: string;
      dist: number;
      hubScore: number | null;
    }>(sql`
      SELECT cs.chat_id AS chatId, cs.character_version_id AS characterVersionId,
             cs.block_idx AS blockIdx, cs.seq_start AS seqStart, cs.seq_end AS seqEnd, cs.text AS text,
             vector_distance_cos(cs.embedding, vector32(${query})) AS dist, cs.hub_score AS hubScore
      FROM vector_top_k('chat_segments_ann', vector32(${query}), ${poolK}) AS v
      JOIN chat_segments cs ON cs.rowid = v.id
      WHERE cs.owner_id = ${ownerId}
      ORDER BY dist ASC
    `);
    const csls = (dist: number, hub: number | null): number =>
      hub === null ? dist : Math.max(0, dist - 1 + hub);
    type Cand = CorpusHit & { rank: number; text: string };
    const cands: Cand[] = [
      ...digRows.map((r) => ({
        source: "digest" as const,
        chatId: r.chatId,
        characterVersionId: r.characterVersionId,
        characterName: "", // resolved after
        tier: r.tier,
        blockIdx: r.blockIdx,
        seqStart: r.seqStart,
        seqEnd: r.seqEnd,
        snippet: r.text.slice(0, SNIPPET_CHARS),
        topicAnchor: r.topicAnchor,
        distance: r.dist,
        rank: csls(r.dist, r.hubScore),
        text: r.text,
      })),
      ...segRows.map((r) => ({
        source: "segment" as const,
        chatId: r.chatId,
        characterVersionId: r.characterVersionId,
        characterName: "", // resolved after
        tier: 0,
        blockIdx: r.blockIdx,
        seqStart: r.seqStart,
        seqEnd: r.seqEnd,
        snippet: r.text.slice(0, SNIPPET_CHARS),
        topicAnchor: null,
        distance: r.dist,
        rank: csls(r.dist, r.hubScore),
        text: r.text,
      })),
    ];
    const rerankId = (c: Cand): string => `${c.source}:${c.chatId}:${c.tier}:${c.blockIdx}`;
    if (rerank && cands.length > 0) {
      const scores = await reranker.rerank(
        queryText,
        cands.map((c) => ({ id: rerankId(c), text: c.text })),
      );
      const order = new Map(scores.map((s, i) => [s.id, i]));
      cands.sort(
        (a, b) =>
          (order.get(rerankId(a)) ?? Number.POSITIVE_INFINITY) -
          (order.get(rerankId(b)) ?? Number.POSITIVE_INFINITY),
      );
    } else {
      cands.sort((a, b) => a.rank - b.rank);
    }
    // Dedupe per block (chatId, tier, blockIdx) — a tier-0 block's digest + segment collapse to the
    // better-ranked lens; keep the first occurrence in ranked order. Cap at k.
    const seen = new Set<string>();
    const out: CorpusHit[] = [];
    for (const c of cands) {
      const key = `${c.chatId}:${c.tier}:${c.blockIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        source: c.source,
        chatId: c.chatId,
        characterVersionId: c.characterVersionId,
        characterName: "", // resolved after
        tier: c.tier,
        blockIdx: c.blockIdx,
        seqStart: c.seqStart,
        seqEnd: c.seqEnd,
        snippet: c.snippet,
        topicAnchor: c.topicAnchor,
        distance: c.distance,
      });
      if (out.length >= k) break;
    }

    const cvIds = [...new Set(out.map((r) => r.characterVersionId))];
    if (cvIds.length > 0) {
      const cvRows = await db
        .select({ id: characterVersions.id, name: characterVersions.name })
        .from(characterVersions)
        .where(inArray(characterVersions.id, cvIds));
      const cvMap = new Map(cvRows.map((r) => [r.id, r.name]));
      for (const hit of out) {
        hit.characterName = cvMap.get(hit.characterVersionId) ?? "Unknown";
      }
    }

    getLog().debug(
      { k, reranked: rerank, fetched: cands.length, hits: out.length },
      "search: corpus (hybrid)",
    );
    return out;
  }
  return { digests, segments, corpus };
}
