// Public API (front door) for the corpus domain feature (embed + store / RAG).
// ST→schema ingestion lives in its peer feature `domain/import/`, not here.

export type { CorpusService } from "./service";
export { createCorpusService } from "./service";
