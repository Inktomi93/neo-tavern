import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characters, characterVersions, chats } from "../../../db/schema";
import { createEmbedder, type Embedder } from "../../embeddings/embedder";
import { createReranker, type Reranker } from "../../embeddings/reranker";
import { getLog } from "../../observability/logger";

export interface SearchHit {
  entityType: string;
  entityId: string;
  /**
   * Raw cosine distance (0 = identical). Lower is nearer. NOTE: hits are ordered by the
   * CSLS-adjusted distance (hubness correction) — or by cross-encoder score when `rerank` is
   * set — NOT by this raw value. A consumer must keep the returned order, not re-sort by it.
   */
  distance: number;
}

/** One conversation snippet backing a discover hit. */
export interface DiscoverSegment {
  chatId: string;
  segIndex: number;
  /** Leading slice of the embedded segment text (the supporting evidence). */
  snippet: string;
  /** Raw cosine distance of this segment to the query. */
  distance: number;
}

/** A character surfaced by discover, ranked by their single best matching segment. */
export interface DiscoverCharacter {
  characterId: string;
  name: string;
  tags: string[];
  description: string;
  /** How many pool segments matched this character. */
  matchCount: number;
  /** Raw cosine distance of the best matching segment (results are ordered by rank, which
   *  is CSLS-adjusted distance, or cross-encoder score when reranked — not this value). */
  bestDistance: number;
  segments: DiscoverSegment[];
}

/** A display-ready knn hit (tagged union — the UI switches on `kind`). Ordered by rank. */
export type FindResult =
  | { kind: "character"; entityId: string; distance: number; name: string; tags: string[] }
  | {
      kind: "segment";
      entityId: string;
      distance: number;
      characterName: string;
      chatId: string;
      segIndex: number;
      snippet: string;
    };

export interface SearchService {
  /** Lean primitive: nearest entities as (entityType, entityId, distance). */
  knn(params: {
    queryText: string;
    k?: number | undefined;
    /** When set, results are restricted to entities owned by this user (multi-user scoping). */
    ownerId?: string | undefined;
    /** Second stage: re-score the CSLS pool with the cross-encoder reranker (4.6.3b). */
    rerank?: boolean | undefined;
  }): Promise<SearchHit[]>;

  /** Display-ready knn: each hit enriched with its name / snippet (the "Find" UI mode). */
  find(params: {
    queryText: string;
    k?: number | undefined;
    ownerId?: string | undefined;
    rerank?: boolean | undefined;
  }): Promise<FindResult[]>;

  /**
   * The killer feature (4.6.3c): "who have I actually done X with?" Searches chat SEGMENTS,
   * groups by character, and returns characters ranked by their single best matching
   * conversation — with the supporting segment snippets — rather than raw segments.
   */
  discover(params: {
    queryText: string;
    k?: number | undefined;
    ownerId?: string | undefined;
    rerank?: boolean | undefined;
  }): Promise<DiscoverCharacter[]>;
}

export interface SearchServiceDeps {
  embedder?: Embedder;
  reranker?: Reranker;
}

// embeddings has no ownerId (denormalizing it invites drift). When scoping, over-fetch and
// resolve ownership through the entity rows. ×8 survives a filtered tail at this corpus size.
const OWNER_OVERFETCH = 8;

// CSLS hubness re-rank pool: fetch more than k so the correction can pull a non-hub from
// positions k+1..(k·F) above a demoted hub. Diverges from card-curator's CSLS-only path
// (pool = n_results, reorder-in-place) — over-fetching is cheap and is the whole point of
// hubness correction (surface the specific match). Also the candidate pool the cross-encoder
// reranker re-scores (card-curator uses n*3; k*4 is comparable). hub_score in domain/corpus.
const CSLS_POOL_FACTOR = 4;

// discover groups a big SEGMENT pool by character, so it needs many more candidates than knn
// — a heavy-tailed corpus (a popular card owns 100+ segments) means k characters need ~k·20
// segments represented. Capped near the ANN budget ceiling (vector_top_k returns only a few
// hundred for a large request — docs/conventions.md); bail to whatever covered if fewer.
const DISCOVER_SEGMENT_POOL_FACTOR = 20;
const DISCOVER_SEGMENT_POOL_CAP = 400;
const DISCOVER_SEGMENTS_PER_CHAR = 3; // best + up to 2 more for drill-down evidence
const SNIPPET_CHARS = 280; // segment text can be ~8KB; a snippet is enough evidence

// A pool candidate carries source_text (for rerank) through CSLS + owner-scoping.
interface Candidate {
  entityType: string;
  entityId: string;
  distance: number;
  sourceText: string | null;
}

interface SegmentDisplay {
  characterId: string;
  name: string;
  tags: string[];
  description: string;
  chatId: string;
  segIndex: number;
}

function chatIdOf(entityId: string): string {
  return entityId.split(":")[0] ?? entityId; // chat_segment entityId = "<chatId>:<segIdx>"
}
function segIndexOf(entityId: string): number {
  return Number(entityId.split(":")[1] ?? 0);
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function createSearchService(db: Db, deps: SearchServiceDeps = {}): SearchService {
  const embedder = deps.embedder ?? createEmbedder();
  const reranker = deps.reranker ?? createReranker();

  // Keep only candidates whose backing entity is owned by ownerId (character → characters,
  // chat_segment → chats). Generic so it can scope the candidate pool (carrying source_text).
  async function scopeToOwner<T extends { entityType: string; entityId: string }>(
    rows: T[],
    ownerId: string,
  ): Promise<T[]> {
    const charIds = rows.filter((r) => r.entityType === "character").map((r) => r.entityId);
    const chatIds = rows
      .filter((r) => r.entityType === "chat_segment")
      .map((r) => chatIdOf(r.entityId));
    const ownedChars =
      charIds.length > 0
        ? new Set(
            (
              await db
                .select({ id: characters.id })
                .from(characters)
                .where(and(eq(characters.ownerId, ownerId), inArray(characters.id, charIds)))
            ).map((r) => r.id),
          )
        : new Set<string>();
    const ownedChats =
      chatIds.length > 0
        ? new Set(
            (
              await db
                .select({ id: chats.id })
                .from(chats)
                .where(and(eq(chats.ownerId, ownerId), inArray(chats.id, chatIds)))
            ).map((r) => r.id),
          )
        : new Set<string>();
    return rows.filter((r) => {
      if (r.entityType === "character") return ownedChars.has(r.entityId);
      if (r.entityType === "chat_segment") return ownedChats.has(chatIdOf(r.entityId));
      return false; // unknown entity type → not owner-resolvable, drop under scoping
    });
  }

  // Stage 2: cross-encoder rerank. Reorders the (owner-scoped, CSLS-ranked) pool by joint
  // (query, source_text) relevance. Candidates without source_text can't be scored — they're
  // left in their CSLS position AFTER the reranked ones (not silently dropped from results).
  async function applyRerank(queryText: string, pool: Candidate[]): Promise<Candidate[]> {
    const scorable = pool.filter((c) => c.sourceText !== null);
    const dropped = pool.length - scorable.length;
    if (dropped > 0) {
      getLog().debug({ dropped }, "search: rerank skipped candidates without source_text");
    }
    if (scorable.length === 0) return pool;
    const scores = await reranker.rerank(
      queryText,
      scorable.map((c) => ({ id: c.entityId, text: c.sourceText ?? "" })),
    );
    const orderByEntityId = new Map(scores.map((s, idx) => [s.id, idx]));
    // Stable sort: scored candidates in reranker order; unscorable ones (Infinity) keep their
    // CSLS order at the tail.
    return [...pool].sort(
      (a, b) =>
        (orderByEntityId.get(a.entityId) ?? Number.POSITIVE_INFINITY) -
        (orderByEntityId.get(b.entityId) ?? Number.POSITIVE_INFINITY),
    );
  }

  // Resolve chat_segment entityIds → the character that owns the chat + its card (via the
  // pinned version). Optional ownerId scopes at the chat (segments of un-owned chats drop out).
  // Shared by discover (grouping) and find (segment rows). Snippet is built by the caller.
  async function resolveSegmentDisplay(
    entityIds: string[],
    ownerId?: string,
  ): Promise<Map<string, SegmentDisplay>> {
    const out = new Map<string, SegmentDisplay>();
    const chatIds = [...new Set(entityIds.map(chatIdOf))];
    if (chatIds.length === 0) return out;
    const chatRows = await db
      .select({ id: chats.id, cvId: chats.characterVersionId })
      .from(chats)
      .where(
        ownerId
          ? and(eq(chats.ownerId, ownerId), inArray(chats.id, chatIds))
          : inArray(chats.id, chatIds),
      );
    const chatToCv = new Map(chatRows.map((r) => [r.id, r.cvId]));
    const cvIds = [...new Set(chatRows.map((r) => r.cvId))];
    if (cvIds.length === 0) return out;
    const cvRows = await db
      .select({
        id: characterVersions.id,
        characterId: characterVersions.characterId,
        name: characterVersions.name,
        tags: characterVersions.tags,
        description: characterVersions.description,
      })
      .from(characterVersions)
      .where(inArray(characterVersions.id, cvIds));
    const cvById = new Map(cvRows.map((r) => [r.id, r]));
    for (const eid of entityIds) {
      const cvId = chatToCv.get(chatIdOf(eid));
      if (cvId === undefined) continue;
      const cv = cvById.get(cvId);
      if (!cv) continue;
      out.set(eid, {
        characterId: cv.characterId,
        name: cv.name,
        tags: asStringArray(cv.tags),
        description: cv.description,
        chatId: chatIdOf(eid),
        segIndex: segIndexOf(eid),
      });
    }
    return out;
  }

  // Resolve characterIds → their CURRENT-version card (name + tags) for find's character rows.
  async function resolveCharacterDisplay(
    charIds: string[],
  ): Promise<Map<string, { name: string; tags: string[] }>> {
    const out = new Map<string, { name: string; tags: string[] }>();
    if (charIds.length === 0) return out;
    const charRows = await db
      .select({ id: characters.id, cvId: characters.currentVersionId })
      .from(characters)
      .where(inArray(characters.id, charIds));
    const cvIds = charRows.map((r) => r.cvId).filter((x): x is string => x !== null);
    if (cvIds.length === 0) return out;
    const cvRows = await db
      .select({
        id: characterVersions.id,
        name: characterVersions.name,
        tags: characterVersions.tags,
      })
      .from(characterVersions)
      .where(inArray(characterVersions.id, cvIds));
    const cvById = new Map(cvRows.map((r) => [r.id, r]));
    for (const c of charRows) {
      if (c.cvId === null) continue;
      const cv = cvById.get(c.cvId);
      if (cv) out.set(c.id, { name: cv.name, tags: asStringArray(cv.tags) });
    }
    return out;
  }

  // source_text for segment hits (find's snippet); discover already has it on its candidates.
  async function fetchSegmentSnippets(entityIds: string[]): Promise<Map<string, string>> {
    if (entityIds.length === 0) return new Map();
    const rows = await db.all<{ entityId: string; sourceText: string | null }>(sql`
      SELECT entity_id AS entityId, source_text AS sourceText
      FROM embeddings WHERE entity_type = 'chat_segment' AND entity_id IN (${sql.join(
        entityIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    return new Map(rows.map((r) => [r.entityId, (r.sourceText ?? "").slice(0, SNIPPET_CHARS)]));
  }

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
    const rows = await db.all<{
      entityType: string;
      entityId: string;
      dist: number;
      hubScore: number | null;
      sourceText: string | null;
    }>(sql`
      SELECT e.entity_type AS entityType, e.entity_id AS entityId,
             vector_distance_cos(e.embedding, vector32(${query})) AS dist,
             e.hub_score AS hubScore, e.source_text AS sourceText
      FROM vector_top_k('embeddings_ann', vector32(${query}), ${poolK}) AS v
      JOIN embeddings e ON e.rowid = v.id
      ORDER BY dist ASC
    `);
    // CSLS hubness correction: adjusted = max(0, dist - 1 + hub_score), demoting vectors that
    // are near everything (card-curator server.py:169). null hub_score → raw distance. The
    // clamp ties the top at 0; V8's sort is STABLE and the pool arrives in raw-dist order, so
    // equal-adjusted hits keep their raw-distance tiebreak — do not make this an unstable sort.
    const adjusted = rows.map((row) => ({
      cand: {
        entityType: row.entityType,
        entityId: row.entityId,
        distance: row.dist,
        sourceText: row.sourceText,
      },
      rank: row.hubScore === null ? row.dist : Math.max(0, row.dist - 1 + row.hubScore),
    }));
    adjusted.sort((a, b) => a.rank - b.rank);
    const pool = adjusted.map((a) => a.cand);
    const scoped = ownerId ? await scopeToOwner(pool, ownerId) : pool;
    const ranked = rerank ? await applyRerank(queryText, scoped) : scoped;
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
    const [charMap, segMap, snippets] = await Promise.all([
      resolveCharacterDisplay(charIds),
      resolveSegmentDisplay(segIds),
      fetchSegmentSnippets(segIds),
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
            snippet: snippets.get(h.entityId) ?? "",
          });
        }
      }
    }
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
    // chat_segment-only pool (cards excluded), CSLS-rankable + rerankable.
    const rows = await db.all<{
      entityId: string;
      dist: number;
      hubScore: number | null;
      sourceText: string | null;
    }>(sql`
      SELECT e.entity_id AS entityId,
             vector_distance_cos(e.embedding, vector32(${query})) AS dist,
             e.hub_score AS hubScore, e.source_text AS sourceText
      FROM vector_top_k('embeddings_ann', vector32(${query}), ${poolK}) AS v
      JOIN embeddings e ON e.rowid = v.id
      WHERE e.entity_type = 'chat_segment'
      ORDER BY dist ASC
    `);
    const pool: Candidate[] = rows
      .map((row) => ({
        cand: {
          entityType: "chat_segment",
          entityId: row.entityId,
          distance: row.dist,
          sourceText: row.sourceText,
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

  return { knn, find, discover };
}
