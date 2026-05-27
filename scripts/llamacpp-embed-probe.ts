import { performance } from "node:perf_hooks";
import process from "node:process";
import { getLlama } from "node-llama-cpp";

/**
 * node-llama-cpp embedding timing pass — the in-process, no-port, GGUF alternative to the
 * ONNX (transformers.js) path. Run the SAME Qwen3-Embedding-0.6B weights as the ONNX probe
 * (scripts/qwen-embed-probe.ts) to answer one question: does llama.cpp's fused GQA kernels
 * avoid the `repeat_kv` CPU-fallback fragmentation that capped the ONNX run at ~488 t/s?
 *
 * The GGUF carries pooling_type=3 (LAST) in metadata → last-token pooling, matching the
 * ONNX `last_token` run. 1024-dim either way.
 *
 *   pnpm tsx scripts/llamacpp-embed-probe.ts
 */
const MODEL_PATH = process.env["GGUF_PATH"] ?? "./.models/gguf/Qwen3-Embedding-0.6B-f16.gguf";
const EXPECTED_DIM = 1024;
// Knobs: FLASH=1 → flash-attention; CTX=N → fan the batch across N embedding contexts
// (the only concurrency path, since getEmbeddingFor locks one sequence per context).
const FLASH = process.env["FLASH"] === "1";
const CTX_FANOUT = Number(process.env["CTX"] ?? "1");

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
  console.log(`model=${MODEL_PATH} gpu=cuda — node-llama-cpp embedding timing pass`);

  // Force CUDA (don't silently fall back to CPU/Vulkan).
  const tBackend0 = performance.now();
  const llama = await getLlama({ gpu: "cuda" });
  const backend = performance.now() - tBackend0;

  const tModel0 = performance.now();
  const model = await llama.loadModel({
    modelPath: MODEL_PATH,
    defaultContextFlashAttention: FLASH,
  });
  const modelLoad = performance.now() - tModel0;
  console.log(`  (flashAttention=${FLASH} · ctxFanout=${CTX_FANOUT})`);

  // batchSize/contextSize large enough that the batch(32) test is truly batched on the GPU,
  // not serialized per call (advisor flag). 32 short texts ≈ a few hundred tokens.
  const tCtx0 = performance.now();
  const context = await model.createEmbeddingContext({ contextSize: 8192, batchSize: 4096 });
  const ctxLoad = performance.now() - tCtx0;

  const embed = async (text: string): Promise<Float32Array> => {
    const e = await context.getEmbeddingFor(text);
    return Float32Array.from(e.vector);
  };

  // First embed (kernel warmup), then steady-state warm singles.
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

  // Batched throughput — Promise.all lets the context pack many seqs into one decode.
  const batchTexts = Array.from(
    { length: 32 },
    (_, i) => `${warmTexts[i % warmTexts.length]} (#${i})`,
  );
  const tBatch0 = performance.now();
  const batchVecs = await Promise.all(batchTexts.map((t) => embed(t)));
  const batch = performance.now() - tBatch0;

  console.log("");
  console.log(`  dim            = ${a.length} (expected ${EXPECTED_DIM})`);
  console.log(`  backend init   = ${ms(backend)}`);
  console.log(`  model load     = ${ms(modelLoad)}`);
  console.log(`  ctx create     = ${ms(ctxLoad)}`);
  console.log(`  first embed    = ${ms(first)}  (incl. kernel warmup)`);
  console.log(`  warm/embed     = ${ms(warmAvg)} avg · ${ms(warmMin)} min  (n=${warm.length})`);
  console.log(
    `  batch(32)      = ${ms(batch)} total · ${ms(batch / batchTexts.length)}/text · ${(
      (batchTexts.length / batch) * 1000
    ).toFixed(1)} texts/s`,
  );

  // Knob test: fan the same 32 texts across N independent contexts (each has its own
  // sequence+lock, so they can overlap on the GPU) — the only way to get concurrency.
  if (CTX_FANOUT > 1) {
    const ctxs = await Promise.all(
      Array.from({ length: CTX_FANOUT }, () =>
        model.createEmbeddingContext({ contextSize: 8192, batchSize: 4096 }),
      ),
    );
    const tFan0 = performance.now();
    await Promise.all(
      batchTexts.map((t, i) => (ctxs[i % CTX_FANOUT] as (typeof ctxs)[number]).getEmbeddingFor(t)),
    );
    const fan = performance.now() - tFan0;
    console.log(
      `  fanout(${CTX_FANOUT})    = ${ms(fan)} total · ${ms(fan / batchTexts.length)}/text · ${(
        (batchTexts.length / fan) * 1000
      ).toFixed(1)} texts/s`,
    );
    await Promise.all(ctxs.map((c) => c.dispose()));
  }

  const related = cosine(a, warmVecs[0] ?? new Float32Array());
  const unrelated = cosine(a, warmVecs[warmVecs.length - 1] ?? new Float32Array());
  console.log("");
  console.log(`  sim related    = ${related.toFixed(3)}`);
  console.log(`  sim unrelated  = ${unrelated.toFixed(3)}`);

  const ok =
    a.length === EXPECTED_DIM && related > unrelated && batchVecs.length === batchTexts.length;
  console.log(
    ok ? "✅ Qwen3-Embedding (GGUF) works (1024-dim; related > unrelated)" : "❌ unexpected result",
  );
  if (!ok) process.exitCode = 1;

  await context.dispose();
  await model.dispose();
}

await main()
  .catch((error: unknown) => {
    console.error("llamacpp embed probe failed:", error);
    process.exitCode = 1;
  })
  // Native CUDA bindings can crash in atexit teardown the same way ORT does — force a clean
  // exit so the probe reports a truthful code.
  .finally(() => process.exit(process.exitCode ?? 0));
