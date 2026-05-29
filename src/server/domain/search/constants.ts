// embeddings has no ownerId (denormalizing it invites drift). When scoping, over-fetch and
// resolve ownership through the entity rows. ×8 survives a filtered tail at this corpus size.
export const OWNER_OVERFETCH = 8;

// CSLS hubness re-rank pool: fetch more than k so the correction can pull a non-hub from
// positions k+1..(k·F) above a demoted hub. Diverges from card-curator's CSLS-only path
// (pool = n_results, reorder-in-place) — over-fetching is cheap and is the whole point of
// hubness correction (surface the specific match). Also the candidate pool the cross-encoder
// reranker re-scores (card-curator uses n*3; k*4 is comparable). hub_score in domain/corpus.
export const CSLS_POOL_FACTOR = 4;

// discover groups a big SEGMENT pool by character, so it needs many more candidates than knn
// — a heavy-tailed corpus (a popular card owns 100+ segments) means k characters need ~k·20
// segments represented. Capped near the ANN budget ceiling (vector_top_k returns only a few
// hundred for a large request — docs/conventions.md); bail to whatever covered if fewer.
export const DISCOVER_SEGMENT_POOL_FACTOR = 20;
export const DISCOVER_SEGMENT_POOL_CAP = 400;
export const DISCOVER_SEGMENTS_PER_CHAR = 3; // best + up to 2 more for drill-down evidence
export const SNIPPET_CHARS = 280; // segment text can be ~8KB; a snippet is enough evidence

// A pool candidate carries source_text (for rerank) through CSLS + owner-scoping.
export interface Candidate {
  entityType: string;
  entityId: string;
  distance: number;
  sourceText: string | null;
}

export interface SegmentDisplay {
  characterId: string;
  name: string;
  tags: string[];
  description: string;
  avatarHash: string | null;
  chatId: string;
  segIndex: number;
  snippet: string;
}
