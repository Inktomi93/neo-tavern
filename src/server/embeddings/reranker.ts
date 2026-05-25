import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env as hf,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { env } from "../env";
import { getLog } from "../observability/logger";

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
// fp16 weights (no fp32). 2-GPU note: to pin the reranker to GPU 1 (concurrent with the
// embedder on GPU 0 during heavy index ops) set CUDA_VISIBLE_DEVICES — but query-time
// embed→rerank is sequential, so the code stays device-agnostic (RERANK_DEVICE/RERANK_DTYPE).
const RERANKER_ID = "onnx-community/bge-reranker-v2-m3-ONNX";
export const RERANKER_MODEL = "bge-reranker-v2-m3";

// Per-pair token cap. BAAI recommends 1024 for bge-reranker-v2-m3 (the length it was
// fine-tuned at; the model supports up to 8192 but longer = quadratically more compute for
// little rerank gain). Cross-encoder attention is O(seq²), so an UNCAPPED long segment (~4k+
// tokens) × the whole pool in one padded batch tries to allocate ~24GB and OOMs the GPU.
const RERANK_MAX_TOKENS = 1024;
// Score the pool in fixed-size chunks so peak memory is bounded (≈ size × MAX_TOKENS²)
// regardless of pool size. The per-pair cap above already bounds per-item cost, so a fixed
// COUNT suffices here — unlike the embed pass, which needs token-budget batching because it
// embeds uncapped full text. 32 × 1024² (fp16) ≈ 1GB/batch; pools are small (k·4), so 1–2
// batches typically. (card-curator batches its Qwen3-VL reranker by a token budget — same
// idea, different model: that one has no fixed per-item cap and an 8B/32k context.)
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

// Lazy singletons — model + tokenizer load (and download once) on first rerank, reused after.
let modelPromise: Promise<PreTrainedModel> | null = null;
let tokenizerPromise: Promise<PreTrainedTokenizer> | null = null;
function getModel(): Promise<PreTrainedModel> {
  if (!modelPromise) {
    getLog().info(
      { model: RERANKER_ID, device: env.RERANK_DEVICE, dtype: env.RERANK_DTYPE },
      "reranker: loading model (one-time)",
    );
    modelPromise = AutoModelForSequenceClassification.from_pretrained(RERANKER_ID, {
      device: env.RERANK_DEVICE,
      dtype: env.RERANK_DTYPE,
    });
  }
  return modelPromise;
}
function getTokenizer(): Promise<PreTrainedTokenizer> {
  if (!tokenizerPromise) tokenizerPromise = AutoTokenizer.from_pretrained(RERANKER_ID);
  return tokenizerPromise;
}

export function createReranker(): Reranker {
  return {
    model: RERANKER_MODEL,

    async rerank(query, docs) {
      if (docs.length === 0) return [];
      const [model, tokenizer] = await Promise.all([getModel(), getTokenizer()]);
      const hits: RerankHit[] = [];
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
          hits.push({ id: chunk[i]?.id ?? "", score: scores[i]?.[0] ?? Number.NEGATIVE_INFINITY });
        }
      }
      return hits.sort((a, b) => b.score - a.score);
    },
  };
}
