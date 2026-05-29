import { performance } from "node:perf_hooks";
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env as hf,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { getAppConfig } from "../config/app-config";
import { env } from "../env";
import { getLog } from "../observability/logger";
import { WarmModel } from "./warm-model";

// Same repo-local model cache as the embedder (transformers.js `env` is a process-global).
hf.cacheDir = env.MODEL_CACHE_DIR;
hf.allowRemoteModels = true;

// Cross-encoder reranker — the SECOND stage of two-stage retrieval (4.6.3b). Stage 1
// (domain/search knn, CSLS-adjusted) over-fetches a candidate pool by bi-encoder vector
// similarity; the reranker re-scores each (query, doc-text) pair JOINTLY (it attends to
// query and doc at once, which a bi-encoder can't), surfacing true relevance. Ported shape
// from card-curator server.py:189-222 (model differs — we use bge-reranker-v2-m3, they Qwen3-VL).
//
// onnx-community/bge-reranker-v2-m3-ONNX: the `Xenova/` id does NOT exist; this repo ships
// fp16 weights (no fp32). It runs on RERANK_GPU_ID (default GPU 1) when RERANK_DEVICE=cuda —
// pinned in-process via session_options.executionProviders, leaving GPU 0 for the embedder +
// summarizer. Warm/idle-unload lifecycle is the shared WarmModel.
const RERANKER_ID = "onnx-community/bge-reranker-v2-m3-ONNX";
export const RERANKER_MODEL = "bge-reranker-v2-m3";

// Per-pair token cap. BAAI recommends 1024 for bge-reranker-v2-m3 (the length it was
// fine-tuned at; the model supports up to 8192 but longer = quadratically more compute for
// little rerank gain). Cross-encoder attention is O(seq²), so an UNCAPPED long segment (~4k+
// tokens) × the whole pool in one padded batch tries to allocate ~24GB and OOMs the GPU.
const RERANK_MAX_TOKENS = 1024;
// Score the pool in fixed-size chunks so peak memory is bounded (≈ size × MAX_TOKENS²)
// regardless of pool size. 32 × 1024² (fp16) ≈ 1GB/batch; pools are small (k·4), so 1–2 batches.
const RERANK_BATCH_SIZE = 32;

export interface RerankDoc {
  id: string;
  text: string;
}
export interface RerankHit {
  id: string;
  /** Raw cross-encoder logit; higher = more relevant (no sigmoid — monotonic, kept honest). */
  score: number;
}

export interface Reranker {
  readonly model: string;
  /** Score each (query, doc.text) pair jointly; returns hits sorted by score DESC. */
  rerank(query: string, docs: RerankDoc[]): Promise<RerankHit[]>;
}

interface Loaded {
  model: PreTrainedModel;
  tokenizer: PreTrainedTokenizer;
}

// Match the embedder: ORT transformer fusions; on CUDA also pin the physical GPU (default 1).
// graphOptimizationLevel: CPU stops at "extended" because the fp16 reranker triggers an ORT bug in
// the "all"-only `SimplifiedLayerNormFusion` (looks up a constant_output_0 by name that the prior
// InsertedPrecisionFreeCast renamed) — crashes during model init. "extended" already includes the
// transformer-specific fusions we care about; "all" only adds the unsafe ones here. On CUDA the
// fusion path is different (CUDA EP-owned), so "all" is fine and validated by the corpus rebuild.
function sessionOptions(): Record<string, unknown> {
  return {
    graphOptimizationLevel: env.RERANK_DEVICE === "cuda" ? "all" : "extended",
    ...(env.RERANK_DEVICE === "cuda"
      ? { executionProviders: [{ name: "cuda", deviceId: env.RERANK_GPU_ID }] }
      : {}),
  };
}

// Shared warm/idle-unload lifecycle. Model + tokenizer load together; unload disposes the model
// (frees VRAM) and the next call cold-reloads both.
const warm = new WarmModel<Loaded>({
  name: `${RERANKER_MODEL}@${env.RERANK_DEVICE}:${env.RERANK_GPU_ID}`,
  idleMs: getAppConfig().idleUnloadMin * 60_000,
  load: async () => {
    const [model, tokenizer] = await Promise.all([
      AutoModelForSequenceClassification.from_pretrained(RERANKER_ID, {
        device: env.RERANK_DEVICE,
        dtype: env.RERANK_DTYPE,
        session_options: sessionOptions(),
      }),
      AutoTokenizer.from_pretrained(RERANKER_ID),
    ]);
    return { model, tokenizer };
  },
  unload: async (loaded) => {
    await loaded.model.dispose();
  },
  warm: async ({ model, tokenizer }) => {
    const inputs = tokenizer(["warm up"], {
      text_pair: ["a relevant document"],
      padding: true,
      truncation: true,
      max_length: RERANK_MAX_TOKENS,
    });
    await model(inputs);
  },
});

/** Eagerly load + JIT the reranker (one (query,doc) pair) so the first real rerank is fast. */
export function warmUpReranker(): Promise<void> {
  return warm.warmUp();
}

export function createReranker(): Reranker {
  return {
    model: RERANKER_MODEL,

    async rerank(query, docs) {
      if (docs.length === 0) return [];
      return warm.use(async ({ model, tokenizer }) => {
        const hits: RerankHit[] = [];
        const start = performance.now();
        for (let b = 0; b < docs.length; b += RERANK_BATCH_SIZE) {
          const chunk = docs.slice(b, b + RERANK_BATCH_SIZE);
          // text_pair batches (query, doc) pairs; both arrays must match in length.
          const inputs = tokenizer(
            chunk.map(() => query),
            {
              text_pair: chunk.map((d) => d.text),
              padding: true,
              truncation: true,
              max_length: RERANK_MAX_TOKENS,
            },
          );
          // [N, 1] logits for this single-label cross-encoder; row[0] is the relevance score.
          const output = await model(inputs);
          const scores = output.logits.tolist() as number[][];
          for (let i = 0; i < chunk.length; i += 1) {
            hits.push({
              id: chunk[i]?.id ?? "",
              score: scores[i]?.[0] ?? Number.NEGATIVE_INFINITY,
            });
          }
        }
        const durationMs = Math.round(performance.now() - start);
        getLog().debug(
          { model: RERANKER_MODEL, queryLength: query.length, docs: docs.length, durationMs },
          "reranker: scored docs",
        );
        return hits.sort((a, b) => b.score - a.score);
      });
    },
  };
}
