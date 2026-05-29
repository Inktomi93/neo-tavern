import process from "node:process";
import { expect, test } from "vitest";
import { createEmbedder } from "../../src/server/embeddings/embedder";
import { createReranker } from "../../src/server/embeddings/reranker";

// ── OPT-IN real-model suite (the homelab A6000s) ─────────────────────────────
// EXCLUDED from the default `pnpm check`: these load the real BGE-M3 embedder + cross-encoder
// reranker (CPU by default; ~21G of weights cached in .models/), so they're slow and the deterministic
// fakes already lock down the LOGIC. They exist to answer the one question fakes CANNOT: do the REAL
// models behave sensibly — closing the #3 "eligibility vs relevance" gap (a relevant arc digest must
// actually OUT-RANK an irrelevant scene under the real cross-encoder, not merely be eligible).
//
// Run on this box:
//   MEMORY_REAL_MODELS=1 RERANK_DTYPE=q8 pnpm exec vitest run tests/integration/memory-real-models.test.ts
//   (RERANK_DTYPE=q8 keeps the reranker CPU-friendly; drop it / set RERANK_DEVICE=cuda to use the GPU.)
// Destructure (not `process.env.X` / `process.env["X"]`) to satisfy both tsc's
// noPropertyAccessFromIndexSignature and Biome's useLiteralKeys, which otherwise conflict.
const { MEMORY_REAL_MODELS } = process.env;
const REAL = MEMORY_REAL_MODELS === "1";

const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
};

test.skipIf(!REAL)(
  "real BGE-M3: 1024 normalized dims, and semantic similarity beats dissimilarity",
  async () => {
    const embedder = createEmbedder();
    const dragon = await embedder.embed("the dragon hoards emeralds deep in its mountain cavern");
    const wyrm = await embedder.embed("the wyrm guards precious jewels inside the cave"); // synonymous
    const taxes = await embedder.embed("quarterly corporate tax filing deadlines and accounting"); // unrelated

    expect(dragon.length).toBe(1024);
    const norm = Math.sqrt([...dragon].reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeCloseTo(1, 1); // CLS + L2-normalized

    // The real model captures synonymy the bag-of-words fake cannot: dragon≈wyrm > dragon≈taxes.
    expect(cosine(dragon, wyrm)).toBeGreaterThan(cosine(dragon, taxes));
  },
  120_000,
);

test.skipIf(!REAL)(
  "real cross-encoder ranks a relevant ARC digest above an unrelated scene (#3 relevance)",
  async () => {
    const reranker = createReranker();
    const query = "what happened with the brass key and the drowned archive";
    const docs = [
      {
        id: "scene-unrelated",
        text: "The cook prepared a hearty stew of root vegetables for the tavern's evening guests.",
      },
      {
        id: "arc-relevant",
        text: "Arc digest: Roan admitted the brass key was his late mentor's; the drowned-archive expedition turned from grave-robbing into grief, and a wary alliance formed with the Cartographer.",
      },
    ];

    const hits = await reranker.rerank(query, docs);

    // rerank returns docs best-first → the relevant arc must lead. This is what fakes can't prove:
    // the coarse arc isn't just ELIGIBLE in the mixC pool, it RANKS correctly against a scene.
    expect(hits[0]?.id).toBe("arc-relevant");
  },
  120_000,
);
