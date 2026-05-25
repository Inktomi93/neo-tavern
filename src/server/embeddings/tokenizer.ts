import { join } from "node:path";
import { Tokenizer } from "@anush008/tokenizers";
import { env } from "../env";
import { getLog } from "../observability/logger";

// REAL BGE-M3 token counts (not a chars/N estimate). transformers.js's built-in tokenizer
// is pure-JS and QUADRATIC on long text (12.7s for a 10k-token card — issue transformers.js
// #612), so we use the native Rust tokenizer here: ~7ms for the same text, linear. It loads
// BGE-M3's tokenizer.json (downloaded by the embedder into MODEL_CACHE_DIR — run an embed or
// `pnpm cuda:setup`+embed once so the file exists). Tokenization is CPU-only by nature (a
// sequential string algorithm — no GPU path exists). To drop the native binary later, kitoken
// (Rust→WASM, HF-compatible) is a drop-in for this module.
//
// Used for the budget-critical paths: token-budget batching (avoid padding-OOM) and any exact
// cap. Segmentation windowing stays on the fast chars-ratio approximation (it groups messages
// into ~2k-token windows — exactness there doesn't change retrieval).

const TOKENIZER_JSON = join(env.MODEL_CACHE_DIR, "Xenova/bge-m3/tokenizer.json");

export interface BgeTokenizer {
  /** Real BGE-M3 token count for each text, in input order. One native batch call. */
  countBatch(texts: string[]): Promise<number[]>;
  /** Real BGE-M3 token count for one text. */
  count(text: string): Promise<number>;
}

let tokenizer: Tokenizer | null = null;
function load(): Tokenizer {
  // fromFile is sync; encode is async. Lazy so importing this module is free.
  if (!tokenizer) {
    getLog().info({ path: TOKENIZER_JSON }, "tokenizer: loading BGE-M3 vocab (one-time)");
    tokenizer = Tokenizer.fromFile(TOKENIZER_JSON);
  }
  return tokenizer;
}

export function createBgeTokenizer(): BgeTokenizer {
  return {
    async countBatch(texts) {
      if (texts.length === 0) return [];
      const encs = await load().encodeBatch(texts);
      return encs.map((e) => e.getLength());
    },
    async count(text) {
      const enc = await load().encode(text, null);
      return enc.getLength();
    },
  };
}
