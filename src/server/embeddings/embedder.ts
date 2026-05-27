import { type FeatureExtractionPipeline, env as hf, pipeline } from "@huggingface/transformers";
import { env } from "../env";
import { WarmModel } from "./warm-model";

// Keep ALL model downloads self-contained in a repo-local, gitignored dir (not the OS HF
// cache or node_modules/.cache). transformers.js `env` is a process-global singleton, so
// setting it here also covers the Phase-4.6.3 reranker. Allow remote download into it.
hf.cacheDir = env.MODEL_CACHE_DIR;
hf.allowRemoteModels = true;

// Local, in-process embeddings: BGE-M3 (1024-dim, locked in dependencies.md) on onnxruntime-node.
//   • EMBED_DEVICE — "cpu" (default; fine for short query embeds, safe for tests/dev) or "cuda"
//     (in-process CUDA EP; needs CUDA-12 libs on LD_LIBRARY_PATH — pnpm cuda:setup).
//   • EMBED_DTYPE — fp32 (default) or fp16 (~30% faster on CUDA, same 1024-dim). cpu-fp32 queries
//     and cuda-fp16 corpus share one vector space.
//   • EMBED_GPU_ID — which physical GPU (CUDA only); pinned in-process via executionProviders.
//   • graphOptimizationLevel "all" — ORT transformer fusions (Attention/LayerNorm/GELU).
//   • Lifecycle (warm load + idle-unload + failure-reset + concurrency) is the shared WarmModel.
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

// graphOptimizationLevel "all" everywhere; on CUDA also pin the physical GPU via an explicit
// executionProviders entry (transformers.js keeps a caller-provided EP — the `??=` seam). On CPU
// we omit it (no CUDA EP available).
function sessionOptions(): Record<string, unknown> {
  return {
    graphOptimizationLevel: "all",
    ...(env.EMBED_DEVICE === "cuda"
      ? { executionProviders: [{ name: "cuda", deviceId: env.EMBED_GPU_ID }] }
      : {}),
  };
}

// Shared warm/idle-unload lifecycle (see warm-model.ts). One pipeline serves all callers.
const warm = new WarmModel<FeatureExtractionPipeline>({
  name: `${EMBEDDING_MODEL}@${env.EMBED_DEVICE}:${env.EMBED_GPU_ID}`,
  idleMs: env.IDLE_UNLOAD_MIN * 60_000,
  load: () =>
    pipeline("feature-extraction", MODEL_ID, {
      device: env.EMBED_DEVICE,
      dtype: env.EMBED_DTYPE,
      session_options: sessionOptions(),
    }),
  unload: (extractor) => extractor.dispose(),
  warm: async (extract) => {
    await extract("warm up", { pooling: "cls", normalize: true });
  },
});

/**
 * Eagerly load BGE-M3 and JIT its kernels at the production call shape (cls + normalize) so the
 * first real request is fast. Called at server boot; idempotent and concurrency-safe.
 */
export function warmUpEmbedder(): Promise<void> {
  return warm.warmUp();
}

export function createEmbedder(): Embedder {
  return {
    model: EMBEDDING_MODEL,

    embed(text: string): Promise<Float32Array> {
      return warm.use(async (extract) => {
        const output = await extract(text, { pooling: "cls", normalize: true });
        return new Float32Array(output.data as ArrayLike<number>);
      });
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      return warm.use(async (extract) => {
        // [N, dim] tensor; tolist() splits it into N plain arrays in input order.
        const output = await extract(texts, { pooling: "cls", normalize: true });
        return (output.tolist() as number[][]).map((row) => Float32Array.from(row));
      });
    },
  };
}
