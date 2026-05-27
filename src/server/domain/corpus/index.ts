// Public API (front door) for the corpus domain feature (embed + store / RAG).
// ST→schema ingestion lives in its peer feature `domain/import/`, not here.

export {
  approxTokens,
  buildCardEmbedText,
  type CardEmbedFields,
  cleanText,
  MIN_SEARCH_TEXT_TOKENS,
  normalizePlaceholders,
} from "./embed-text";
export {
  CSLS_K,
  computeCharacterHubScores,
  computeDigestHubScores,
  computeSegmentHubScores,
  type HubStats,
  type HubTypeStat,
} from "./hubness";
export { type Segment, type SegmentMessage, segmentChat } from "./segment";
export { type CorpusService, createCorpusService, type EmbedItem } from "./service";
export { collectEmbedTargets } from "./targets";
