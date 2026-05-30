import type { Embedder } from "../../embeddings/embedder";
import type { ImageEmbedder } from "../../embeddings/image-embedder";
import type { Reranker } from "../../embeddings/reranker";

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

export interface ImageSearchHit {
  assetId: string;
  assetHash: string;
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
  avatarHash: string | null;
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

/** A cross-chat corpus hit over the DIGEST substrate. Ordered by CSLS-adjusted distance (or by
 *  cross-encoder score when reranked) — keep the returned order. The seq span is the click-through. */
export interface DigestSearchHit {
  chatId: string;
  characterVersionId: string;
  characterName: string;
  tier: number;
  blockIdx: number;
  seqStart: number;
  seqEnd: number;
  topicAnchor: string | null;
  /** Leading slice of the digest text (the supporting evidence). */
  snippet: string;
  /** Raw cosine distance (ordering is CSLS/rerank — do not re-sort by this). */
  distance: number;
}

/** A cross-chat corpus hit over the raw SEGMENT substrate (verbatim half of the hybrid). */
export interface SegmentSearchHit {
  chatId: string;
  characterVersionId: string;
  characterName: string;
  blockIdx: number;
  seqStart: number;
  seqEnd: number;
  /** Leading slice of the block's raw verbatim text (the supporting evidence). */
  snippet: string;
  distance: number;
}

/** One hit in the UNIFIED hybrid corpus search — a single ranked list across both substrates
 *  (structured digests + raw segments), deduped per block, joint cross-encoder reranked. `source`
 *  says which lens won the block; the seq span is the verbatim click-through. */
export interface CorpusHit {
  source: "digest" | "segment";
  chatId: string;
  characterVersionId: string;
  characterName: string;
  tier: number;
  blockIdx: number;
  seqStart: number;
  seqEnd: number;
  snippet: string;
  topicAnchor: string | null;
  distance: number;
}

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

  /**
   * Cross-chat corpus search over the structured DIGEST substrate (docs/subsystems/chat-memory.md §4): the same
   * within-chat memory digests, queried GLOBALLY but SCOPED to the owner. A USER-facing search tool
   * — distinct from in-character memory injection, which never crosses chats. Hits carry the canon
   * seq span for verbatim click-through.
   */
  digests(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
    /** Restrict to a digest altitude: 'scene' (tier 0), 'arc' (tier 1+), or 'any' (default). */
    tier?: "scene" | "arc" | "any" | undefined;
  }): Promise<DigestSearchHit[]>;

  /** Cross-chat corpus search over the raw SEGMENT substrate (verbatim half of the hybrid). Same
   *  owner-scoping + CSLS + optional rerank as digests; hits carry the seq span for click-through. */
  segments(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<SegmentSearchHit[]>;

  /** The hybrid "mix" — ONE ranked list over both substrates (digests = theme, segments =
   *  verbatim), deduped per block, joint cross-encoder reranked across the two lenses. */
  corpus(params: {
    queryText: string;
    username: string;
    k?: number | undefined;
    rerank?: boolean | undefined;
  }): Promise<CorpusHit[]>;

  /** Image search over the image_embeddings table using SigLIP text encoding. */
  images(params: { queryText: string; k?: number | undefined }): Promise<ImageSearchHit[]>;
}

export interface SearchServiceDeps {
  embedder?: Embedder;
  imageEmbedder?: ImageEmbedder;
  reranker?: Reranker;
}
