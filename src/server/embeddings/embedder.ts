import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";

// Local embeddings, BGE-M3 (1024-dim, locked in dependencies.md). Runs in-process on
// the CPU ONNX runtime — embedding is a batch/index job, never the chat hot path, so
// CPU is fine for the one-time corpus index. To use the GPU later, add
// `{ device: "cuda" }` to the pipeline() call (needs the CUDA onnxruntime EP) — a
// one-line flip. The dim must match the embeddings.embedding F32_BLOB(1024) column.
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
  pipelinePromise ??= pipeline("feature-extraction", MODEL_ID);
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
