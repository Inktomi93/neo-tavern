import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { env } from "../env";

// Local, in-process embeddings: BGE-M3 (1024-dim, locked in dependencies.md) on
// onnxruntime-node. EMBED_DEVICE picks the execution provider: "cpu" (default — fine for
// short query embeds ~0.04s, and the safe default for tests/dev) or "cuda" (the in-process
// CUDA EP, ~24× faster on long text — used for the corpus embed pass; needs CUDA-12 runtime
// libs on LD_LIBRARY_PATH, see docs/corpus-import.md). Same model both ways, so CPU-embedded
// queries and GPU-embedded corpus share one vector space. Dim must match the
// embeddings.embedding F32_BLOB(1024) column.
const MODEL_ID = "Xenova/bge-m3";
export const EMBEDDING_MODEL = "bge-m3";
export const EMBEDDING_DIM = 1024;

export interface Embedder {
  /** Stored on the embeddings row (the `model` column). */
  readonly model: string;
  /** Normalized 1024-dim dense embedding (BGE-M3 CLS pooling). */
  embed(text: string): Promise<Float32Array>;
}

// Lazy singleton — the model loads (and downloads, once) on first embed, not at import.
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
function getPipeline(): Promise<FeatureExtractionPipeline> {
  pipelinePromise ??= pipeline("feature-extraction", MODEL_ID, { device: env.EMBED_DEVICE });
  return pipelinePromise;
}

export function createEmbedder(): Embedder {
  return {
    model: EMBEDDING_MODEL,
    async embed(text: string): Promise<Float32Array> {
      const extract = await getPipeline();
      const output = await extract(text, { pooling: "cls", normalize: true });
      return new Float32Array(output.data as ArrayLike<number>);
    },
  };
}
