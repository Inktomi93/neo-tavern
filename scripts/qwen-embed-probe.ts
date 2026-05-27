import { performance } from "node:perf_hooks";
import process from "node:process";
import { env as hf, pipeline } from "@huggingface/transformers";

/**
 * Timing pass for onnx-community/Qwen3-Embedding-0.6B-ONNX through the SAME in-process
 * transformers.js → onnxruntime-node path as the production BGE-M3 embedder, so the numbers
 * are comparable to `pnpm embed:probe`. This is a BENCHMARK ONLY — BGE-M3 stays the locked
 * production embedder; this script never touches createEmbedder().
 *
 * Qwen3-Embedding differs from BGE-M3: it's a CausalLM-derived embedder → `last_token`
 * pooling (not `cls`), and queries want an Instruct prefix (we skip it here — we're timing
 * raw embed cost, not retrieval quality). Still 1024-dim, so the vector shape matches.
 *
 *   pnpm tsx scripts/qwen-embed-probe.ts                          # cpu / fp32
 *   EMBED_DEVICE=cuda EMBED_DTYPE=fp16 pnpm tsx scripts/qwen-embed-probe.ts   # GPU (tools/cuda libs)
 *   EMBED_DTYPE=q8 ...                                            # quantized variant
 */
const MODEL_ID = process.env["QWEN_MODEL"] ?? "onnx-community/Qwen3-Embedding-0.6B-ONNX";
const DEVICE = (process.env["EMBED_DEVICE"] ?? "cpu") as "cpu" | "cuda";
const DTYPE = (process.env["EMBED_DTYPE"] ?? "fp32") as "fp32" | "fp16" | "q8";
const EXPECTED_DIM = 1024;
// DIAG=1 → split tokenize vs forward-pass time + dump token counts.
const DIAG = process.env["DIAG"] === "1";
// ORT_LOG_LEVEL: 0=VERBOSE (per-node provider placement → catches CPU fallback), 1=INFO,
// 2=WARNING, 3=ERROR, 4=FATAL. Unset → transformers.js default (quiet).
const ORT_LOG_LEVEL = process.env["ORT_LOG_LEVEL"];

// Mirror embedder.ts: keep downloads in the repo-local gitignored cache, allow remote pull.
hf.cacheDir = process.env["MODEL_CACHE_DIR"] ?? "./.models";
hf.allowRemoteModels = true;

const ms = (n: number): string => `${n.toFixed(1)}ms`;

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main(): Promise<void> {
  console.log(`model=${MODEL_ID} device=${DEVICE} dtype=${DTYPE} — Qwen3-Embedding timing pass`);

  // Cold: model load (+ one-time download) AND the pipeline construction. We time load
  // separately from the first embed by constructing the pipeline, then embedding.
  const tLoad0 = performance.now();
  const extract = await pipeline("feature-extraction", MODEL_ID, {
    dtype: DTYPE,
    device: DEVICE,
    session_options: {
      graphOptimizationLevel: "all",
      ...(ORT_LOG_LEVEL !== undefined
        ? { logSeverityLevel: Number(ORT_LOG_LEVEL) as 0 | 1 | 2 | 3 | 4 }
        : {}),
    },
  });
  const load = performance.now() - tLoad0;

  const embed = async (text: string): Promise<Float32Array> => {
    const out = await extract(text, { pooling: "last_token", normalize: true });
    return new Float32Array(out.data as ArrayLike<number>);
  };

  // First embed (warmup kernels) then steady-state warm embeds.
  const tFirst0 = performance.now();
  const a = await embed("The dragon breathed fire over the castle walls.");
  const first = performance.now() - tFirst0;

  const warmTexts = [
    "A wyrm scorched the fortress ramparts with flame.",
    "The knight raised her shield against the searing heat.",
    "Embers drifted across the moonlit courtyard.",
    "She sheathed her blade and turned toward the gate.",
    "I reconciled the quarterly budget spreadsheet.",
  ];
  const warm: number[] = [];
  const warmVecs: Float32Array[] = [];
  for (const t of warmTexts) {
    const t0 = performance.now();
    warmVecs.push(await embed(t));
    warm.push(performance.now() - t0);
  }
  const warmAvg = warm.reduce((s, n) => s + n, 0) / warm.length;
  const warmMin = Math.min(...warm);

  // Batched throughput — one extract() over N texts.
  const batchTexts = Array.from(
    { length: 32 },
    (_, i) => `${warmTexts[i % warmTexts.length]} (#${i})`,
  );
  const tBatch0 = performance.now();
  const batchOut = await extract(batchTexts, { pooling: "last_token", normalize: true });
  const batch = performance.now() - tBatch0;
  const batchRows = (batchOut.tolist() as number[][]).length;

  console.log("");
  console.log(`  dim            = ${a.length} (expected ${EXPECTED_DIM})`);
  console.log(`  load (model)   = ${ms(load)}`);
  console.log(`  first embed    = ${ms(first)}  (incl. kernel warmup)`);
  console.log(`  warm/embed     = ${ms(warmAvg)} avg · ${ms(warmMin)} min  (n=${warm.length})`);
  console.log(
    `  batch(32)      = ${ms(batch)} total · ${ms(batch / batchTexts.length)}/text · ${(
      (batchTexts.length / batch) * 1000
    ).toFixed(1)} texts/s`,
  );

  if (DIAG) {
    // Reach into the pipeline internals to time tokenize vs. forward pass separately.
    // (FeatureExtractionPipeline exposes .tokenizer and .model.)
    // biome-ignore lint/suspicious/noExplicitAny: probing internal pipeline fields.
    const tok = (extract as any).tokenizer;
    // biome-ignore lint/suspicious/noExplicitAny: probing internal pipeline fields.
    const mdl = (extract as any).model;
    const N = 16;
    const diagTexts = Array.from({ length: N }, (_, i) => warmTexts[i % warmTexts.length] ?? "");

    let tokTotal = 0;
    let fwdTotal = 0;
    let lastSeqLen = 0;
    for (const t of diagTexts) {
      const t0 = performance.now();
      const enc = tok(t, { padding: true, truncation: true });
      tokTotal += performance.now() - t0;
      lastSeqLen = enc.input_ids.dims.at(-1) ?? 0;
      const t1 = performance.now();
      await mdl(enc);
      fwdTotal += performance.now() - t1;
    }
    console.log("");
    console.log(`  [DIAG] per-text over n=${N} (single, padded):`);
    console.log(`  [DIAG]   tokenize  = ${ms(tokTotal / N)}  (seqLen≈${lastSeqLen} tokens)`);
    console.log(`  [DIAG]   forward   = ${ms(fwdTotal / N)}`);
    console.log(`  [DIAG]   tok share = ${((tokTotal / (tokTotal + fwdTotal)) * 100).toFixed(1)}%`);
  }

  const related = cosine(a, warmVecs[0] ?? new Float32Array());
  const unrelated = cosine(a, warmVecs[warmVecs.length - 1] ?? new Float32Array());
  console.log("");
  console.log(`  sim related    = ${related.toFixed(3)}`);
  console.log(`  sim unrelated  = ${unrelated.toFixed(3)}`);

  const ok = a.length === EXPECTED_DIM && related > unrelated && batchRows === batchTexts.length;
  console.log(
    ok ? "✅ Qwen3-Embedding works (1024-dim; related > unrelated)" : "❌ unexpected result",
  );
  if (!ok) process.exitCode = 1;
}

await main()
  .catch((error: unknown) => {
    console.error("qwen embed probe failed:", error);
    process.exitCode = 1;
  })
  // Skip onnxruntime-node's CUDA-EP atexit heap fault (microsoft/onnxruntime#19768).
  .finally(() => process.exit(process.exitCode ?? 0));
