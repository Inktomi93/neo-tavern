import { performance } from "node:perf_hooks";
import process from "node:process";
import { createEmbedder, EMBEDDING_DIM } from "../src/server/embeddings/embedder";
import { env } from "../src/server/env";

/**
 * Live BGE-M3 check + timing pass (downloads the model once; NOT part of `pnpm check`).
 * Proves the real embedder (dim == 1024, related text scores closer than unrelated) AND
 * reports load vs. steady-state embed cost for the active device. Run on demand:
 *   pnpm embed:probe                           # cpu / fp32 (defaults)
 *   EMBED_DEVICE=cuda EMBED_DTYPE=fp16 pnpm embed:probe   # GPU (needs tools/cuda libs)
 */
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

const ms = (n: number): string => `${n.toFixed(1)}ms`;

async function main(): Promise<void> {
  const embedder = createEmbedder();
  console.log(`device=${env.EMBED_DEVICE} dtype=${env.EMBED_DTYPE} — BGE-M3 timing pass`);

  // Cold call: triggers the one-time model load (+ download on first ever run) AND one embed.
  const tCold0 = performance.now();
  const a = await embedder.embed("The dragon breathed fire over the castle walls.");
  const cold = performance.now() - tCold0;

  // Warm single embeds — steady-state per-text cost once the model is resident.
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
    warmVecs.push(await embedder.embed(t));
    warm.push(performance.now() - t0);
  }
  const warmAvg = warm.reduce((s, n) => s + n, 0) / warm.length;
  const warmMin = Math.min(...warm);

  // Batched throughput — one extract() over N texts (the GPU's real lever).
  const batchTexts = Array.from(
    { length: 32 },
    (_, i) => `${warmTexts[i % warmTexts.length]} (#${i})`,
  );
  const tBatch0 = performance.now();
  const batchVecs = await embedder.embedBatch(batchTexts);
  const batch = performance.now() - tBatch0;

  // load ≈ cold minus a single warm embed (cold = load + 1 embed).
  const loadEst = cold - warmMin;

  console.log("");
  console.log(`  dim            = ${a.length} (expected ${EMBEDDING_DIM})`);
  console.log(`  cold (load+1)  = ${ms(cold)}`);
  console.log(`  load (est.)    = ${ms(loadEst)}`);
  console.log(`  warm/embed     = ${ms(warmAvg)} avg · ${ms(warmMin)} min  (n=${warm.length})`);
  console.log(
    `  batch(32)      = ${ms(batch)} total · ${ms(batch / batchTexts.length)}/text · ${(
      (batchTexts.length / batch) * 1000
    ).toFixed(1)} texts/s`,
  );

  // Correctness: dim + related(a,b) > unrelated(a,c). c is the budget sentence (last warm).
  const related = cosine(a, warmVecs[0] ?? new Float32Array());
  const unrelated = cosine(a, warmVecs[warmVecs.length - 1] ?? new Float32Array());
  console.log("");
  console.log(`  sim related    = ${related.toFixed(3)}`);
  console.log(`  sim unrelated  = ${unrelated.toFixed(3)}`);

  const ok =
    a.length === EMBEDDING_DIM && related > unrelated && batchVecs.length === batchTexts.length;
  console.log(ok ? "✅ BGE-M3 works (1024-dim; related > unrelated)" : "❌ unexpected result");
  if (!ok) {
    process.exitCode = 1;
  }
}

await main()
  .catch((error: unknown) => {
    console.error("embed probe failed:", error);
    process.exitCode = 1;
  })
  // onnxruntime-node's CUDA EP corrupts the heap in its atexit/static destructors
  // (microsoft/onnxruntime#19768) — a successful GPU run otherwise dies with SIGABRT (134).
  // Force a clean exit after the work is done so the probe reports a truthful exit code.
  .finally(() => process.exit(process.exitCode ?? 0));
