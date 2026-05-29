import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { assets, characters, characterVersions, chatSegments } from "../../../db/schema";
import type { Reranker } from "../../embeddings/reranker";
import { getLog } from "../../observability/logger";
import { type Candidate, type SegmentDisplay, SNIPPET_CHARS } from "./constants";

export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function createSearchInternal(db: Db, reranker: Reranker) {
  // Keep only candidates whose backing entity is owned by ownerId (character → characters,
  // chat_segment → chats). Generic so it can scope the candidate pool (carrying source_text).

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

  // Resolve segment entityIds ("<chatId>:<blockIdx>") → the owning character's card + the block's
  // raw snippet, reading the first-class chat_segments table (Phase B — segments left the polymorphic
  // embeddings table). owner_id is a direct column, so an optional ownerId scopes without a chats
  // join. Shared by discover (grouping) and find (segment rows).
  async function resolveSegmentDisplay(
    entityIds: string[],
    ownerId?: string,
  ): Promise<Map<string, SegmentDisplay>> {
    const out = new Map<string, SegmentDisplay>();
    if (entityIds.length === 0) return out;
    const segRows = await db
      .select({
        id: chatSegments.id,
        chatId: chatSegments.chatId,
        blockIdx: chatSegments.blockIdx,
        cvId: chatSegments.characterVersionId,
        text: chatSegments.text,
      })
      .from(chatSegments)
      .where(
        ownerId
          ? and(eq(chatSegments.ownerId, ownerId), inArray(chatSegments.id, entityIds))
          : inArray(chatSegments.id, entityIds),
      );
    if (segRows.length === 0) return out;
    const cvIds = [...new Set(segRows.map((r) => r.cvId))];
    const cvRows = await db
      .select({
        id: characterVersions.id,
        characterId: characterVersions.characterId,
        name: characterVersions.name,
        tags: characterVersions.tags,
        description: characterVersions.description,
        avatarHash: assets.hash,
      })
      .from(characterVersions)
      .leftJoin(assets, eq(characterVersions.avatarAssetId, assets.id))
      .where(inArray(characterVersions.id, cvIds));
    const cvById = new Map(cvRows.map((r) => [r.id, r]));
    for (const r of segRows) {
      const cv = cvById.get(r.cvId);
      if (!cv) continue;
      out.set(r.id, {
        characterId: cv.characterId,
        name: cv.name,
        tags: asStringArray(cv.tags),
        description: cv.description,
        avatarHash: cv.avatarHash,
        chatId: r.chatId,
        segIndex: r.blockIdx,
        snippet: (r.text ?? "").slice(0, SNIPPET_CHARS),
      });
    }
    return out;
  }

  // Resolve characterIds → their CURRENT-version card (name + tags) for find's character rows.
  async function resolveCharacterDisplay(
    charIds: string[],
  ): Promise<Map<string, { name: string; tags: string[]; avatarHash: string | null }>> {
    const out = new Map<string, { name: string; tags: string[]; avatarHash: string | null }>();
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
        avatarHash: assets.hash,
      })
      .from(characterVersions)
      .leftJoin(assets, eq(characterVersions.avatarAssetId, assets.id))
      .where(inArray(characterVersions.id, cvIds));
    const cvById = new Map(cvRows.map((r) => [r.id, r]));
    for (const c of charRows) {
      if (c.cvId === null) continue;
      const cv = cvById.get(c.cvId);
      if (cv)
        out.set(c.id, { name: cv.name, tags: asStringArray(cv.tags), avatarHash: cv.avatarHash });
    }
    return out;
  }

  return { applyRerank, resolveSegmentDisplay, resolveCharacterDisplay };
}
