import process from "node:process";
import { createEmbedder, EMBEDDING_DIM } from "../src/server/embeddings/embedder";

/**
 * Live BGE-M3 check (downloads the model once; NOT part of `pnpm check`). Proves the
 * real embedder: dim == 1024, and that semantically related text scores closer than
 * unrelated text. Run on demand: `pnpm embed:probe`.
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

async function main(): Promise<void> {
  const embedder = createEmbedder();
  console.log("loading BGE-M3 (downloads once, then cached)…");
  const a = await embedder.embed("The dragon breathed fire over the castle walls.");
  const b = await embedder.embed("A wyrm scorched the fortress ramparts with flame.");
  const c = await embedder.embed("I reconciled the quarterly budget spreadsheet.");

  const related = cosine(a, b);
  const unrelated = cosine(a, c);
  console.log(`dim=${a.length} (expected ${EMBEDDING_DIM})`);
  console.log(`sim related   = ${related.toFixed(3)}`);
  console.log(`sim unrelated = ${unrelated.toFixed(3)}`);

  const ok = a.length === EMBEDDING_DIM && related > unrelated;
  console.log(ok ? "✅ BGE-M3 works (1024-dim; related > unrelated)" : "❌ unexpected result");
  if (!ok) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  console.error("embed probe failed:", error);
  process.exitCode = 1;
});
