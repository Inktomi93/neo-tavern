import { performance } from "node:perf_hooks";
import { type FeatureExtractionPipeline, env as hf, pipeline } from "@huggingface/transformers";
import { getAppConfig } from "../config/app-config";
import { env } from "../env";
import { getLog } from "../observability/logger";
import { sessionOptions } from "./session-options";
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

// Padded-token budget per forward pass. transformers.js pads a batch to its LONGEST member, and
// self-attention cost scales with (batch × paddedLen²); a few long texts (BGE-M3 truncates at
// 8192 tok) in one batch can demand tens of GB and OOM the GPU. Packing length-sorted batches
// under `paddedLen × size ≤ MAX_BATCH_TOKENS` bounds attention to ≈ budget × heads × maxLen × 2
// (≈8.6 GB at the 8192 cap) — the same budget the corpus embed pass (embed-corpus.ts) runs at.
const MAX_BATCH_TOKENS = 32768;

export interface Embedder {
  /** Stored on the embeddings row (the `model` column). */
  readonly model: string;
  /** Normalized 1024-dim dense embedding (BGE-M3 CLS pooling). */
  embed(text: string): Promise<Float32Array>;
  /** Batched embed — one GPU pass for many texts. Returns vectors in input order. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

// Shared warm/idle-unload lifecycle (see warm-model.ts). One pipeline serves all callers.
const warm = new WarmModel<FeatureExtractionPipeline>({
  name: `${EMBEDDING_MODEL}@${env.EMBED_DEVICE}:${env.EMBED_GPU_ID}`,
  idleMs: getAppConfig().idleUnloadMin * 60_000,
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
        const start = performance.now();
        const output = await extract(text, { pooling: "cls", normalize: true });
        const durationMs = Math.round(performance.now() - start);
        getLog().debug(
          { model: EMBEDDING_MODEL, textLength: text.length, durationMs },
          "embedder: generated embedding",
        );
        return new Float32Array(output.data as ArrayLike<number>);
      });
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      return warm.use(async (extract) => {
        // [N, dim] tensor; tolist() splits it into N plain arrays in input order.
        const run = async (batch: string[]): Promise<Float32Array[]> => {
          const start = performance.now();
          const output = await extract(batch, { pooling: "cls", normalize: true });
          const durationMs = Math.round(performance.now() - start);
          getLog().debug(
            { model: EMBEDDING_MODEL, batchSize: batch.length, durationMs },
            "embedder: embedded batch",
          );
          return (output.tolist() as number[][]).map((row) => Float32Array.from(row));
        };
        if (texts.length === 1) return run(texts);

        // Length-sort, then pack batches under MAX_BATCH_TOKENS so a few long texts can't blow up
        // the padded tensor (see the constant). Lengths come from the pipeline's own tokenizer
        // (no second model load); input order is restored via the original indices.
        const lens = texts.map((t) => extract.tokenizer.encode(t).length);
        const order = texts.map((_, i) => i).sort((a, b) => (lens[a] ?? 0) - (lens[b] ?? 0));
        const out = new Array<Float32Array>(texts.length);
        let group: number[] = [];
        let groupMax = 0;
        const flush = async (): Promise<void> => {
          if (group.length === 0) return;
          const vecs = await run(group.map((i) => texts[i] as string));
          for (const [k, idx] of group.entries()) out[idx] = vecs[k] as Float32Array;
          group = [];
          groupMax = 0;
        };
        for (const i of order) {
          const len = Math.max(1, lens[i] ?? 0);
          // Guard `group.length > 0` so a single over-budget text still gets its own pass
          // (the pipeline truncates it to the model's 8192-token max).
          if (group.length > 0 && Math.max(groupMax, len) * (group.length + 1) > MAX_BATCH_TOKENS) {
            await flush();
          }
          group.push(i);
          groupMax = Math.max(groupMax, len);
        }
        await flush();
        return out;
      });
    },
  };
}
