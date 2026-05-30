import type { GenerationParams } from "../../../../shared/generation";
import type { Embedder } from "../../../embeddings/embedder";
import type { Reranker } from "../../../embeddings/reranker";
import type { Summarizer } from "../../../embeddings/summarizer";

export type MemoryConfig = NonNullable<GenerationParams["memory"]>;

// Retrieval needs the embedder (query vector, mixB/C) + reranker (mixC); generation needs the
// embedder (digest vectors) + summarizer. Two narrow dep shapes so callers inject only what they use.
export interface RetrieveMemoryDeps {
  embedder: Embedder;
  reranker: Reranker;
}
export interface GenerateDigestsDeps {
  embedder: Embedder;
  summarizer: Summarizer;
}

export interface MsgRow {
  seq: number;
  role: string;
  content: string;
  editedAt: number | null;
}
export interface DigestRow {
  tier: number;
  blockIdx: number;
  seqStart: number;
  seqEnd: number;
  text: string;
  keywords: string[];
  createdAt: number;
  embedding: Float32Array | null;
}
// A staged (re)write before the batched embed + upsert.
export interface PendingDigest {
  tier: number;
  blockIdx: number;
  seqStart: number;
  seqEnd: number;
  text: string;
  topicAnchor: string | null;
  keywords: string[];
  summarizerModel: string;
  // sha256 of the SOURCE block (rendered raw transcript) for tier 0; null for tier 1+ consolidations
  // (no single raw source). The fork/import dedup key — docs B.5.1.
  contentHash: string | null;
}
export interface ChatMeta {
  ownerId: string;
  characterVersionId: string;
  charName: string;
  userName: string;
}
