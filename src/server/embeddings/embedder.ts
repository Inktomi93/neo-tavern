import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { env } from "../env";

// Local, in-process embeddings: BGE-M3 (1024-dim, locked in dependencies.md) on
// onnxruntime-node. Tuned per ORT CUDA best-practice for a text transformer:
//   • EMBED_DEVICE — "cpu" (default; fine for short query embeds ~0.04s, safe for tests/dev)
//     or "cuda" (in-process CUDA EP; needs CUDA-12 libs on LD_LIBRARY_PATH — pnpm cuda:setup).
//   • EMBED_DTYPE — fp32 (default) or fp16 (~30% faster on CUDA, same 1024-dim; TF32 is
//     auto-on for the Ampere A6000s). Same model + dim either way, so cpu-fp32 queries and
//     cuda-fp16 corpus share one vector space.
//   • BATCHING — embedBatch() runs N texts through one extract() call (the #1 GPU-throughput
//     lever; one-at-a-time leaves the card idle between ops). The embed pass uses it.
//   • graphOptimizationLevel "all" — op fusion (FusedMatMul etc.).
//   • Model loads ONCE (lazy singleton), reused for every call — never reloaded per op.
//   • Pick the card with CUDA_VISIBLE_DEVICES (e.g. =1) to leave a GPU for the reranker.
const MODEL_ID = "Xenova/bge-m3";
export const EMBEDDING_MODEL = "bge-m3";
export const EMBEDDING_DIM = 1024;

export interface Embedder {
  /** Stored on the embeddings row (the `model` column). */
  readonly model: string;
  /** Normalized 1024-dim dense embedding (BGE-M3 CLS pooling). */
  embed(text: string): Promise<Float32Array>;
  /** Batched embed — one GPU pass for many texts. Returns vectors in input order. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

// Lazy singleton — the model loads (and downloads, once) on first embed, not at import,
// and is reused for every subsequent call (no per-op load/unload).
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
function getPipeline(): Promise<FeatureExtractionPipeline> {
  pipelinePromise ??= pipeline("feature-extraction", MODEL_ID, {
    device: env.EMBED_DEVICE,
    dtype: env.EMBED_DTYPE,
    session_options: { graphOptimizationLevel: "all" },
  });
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

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const extract = await getPipeline();
      // [N, dim] tensor; tolist() splits it into N plain arrays in input order.
      const output = await extract(texts, { pooling: "cls", normalize: true });
      const rows = output.tolist() as number[][];
      return rows.map((row) => Float32Array.from(row));
    },
  };
}
