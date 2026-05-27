import { performance } from "node:perf_hooks";
import process from "node:process";
import { OpenRouter } from "@openrouter/sdk";
import { createEmbedder } from "../src/server/embeddings/embedder";
import { env } from "../src/server/env";

/**
 * Quality head-to-head: our in-process BGE-M3 (ONNX) vs hosted qwen/qwen3-embedding-8b
 * (OpenRouter). A small RP-flavored retrieval set with KNOWN answers — queries are
 * lexically different from their target doc (synonyms/paraphrase) so it tests *semantic*
 * matching, not keyword overlap. Metrics: top-1 accuracy, MRR, and mean margin
 * (cos(relevant) − best distractor) = separation quality.
 *
 * Each model is used the way it's meant to be: BGE-M3 symmetric (as our pipeline runs it);
 * Qwen asymmetric via inputType search_query/search_document (its instruct convention).
 *
 *   EMBED_DEVICE=cpu pnpm tsx scripts/embedder-compare.ts   (quality is device-independent)
 */
const QWEN_MODEL = process.env["QWEN_MODEL"] ?? "qwen/qwen3-embedding-8b";

const DOCS: { id: string; text: string }[] = [
  {
    id: "dragon",
    text: "The dragon Vaelthyr coils atop the obsidian spire, loosing gouts of flame across the ruined keep.",
  },
  {
    id: "knight",
    text: "Sir Edmund kneels in the chapel before dawn, praying for courage on the eve of the siege.",
  },
  {
    id: "thieves",
    text: "The thieves' guild gathers in the cellar beneath the tavern to divide the night's takings.",
  },
  {
    id: "alchemist",
    text: "Lyra the alchemist grinds moonpetal into a tincture that numbs pain but clouds the mind.",
  },
  {
    id: "merchant",
    text: "A merchant caravan rolls into the market square, hawking silks and spices from the southern ports.",
  },
  {
    id: "lighthouse",
    text: "The old lighthouse keeper logs every passing ship and the storms that batter the cliffs.",
  },
  {
    id: "voyage",
    text: "Captain Maren steers the galleon through the reef, bellowing orders as waves crash over the deck.",
  },
  {
    id: "apprentice",
    text: "In the academy library, an apprentice copies forbidden runes by guttering candlelight.",
  },
  { id: "spy", text: "The queen's spymaster intercepts a coded letter hinting at a brewing coup." },
  {
    id: "wolves",
    text: "Wolves circle the shepherd's flock as snow blankets the high mountain pass.",
  },
  {
    id: "smith",
    text: "The blacksmith hammers a blade from star-metal, sparks leaping in the forge's glow.",
  },
  {
    id: "bard",
    text: "A bard recounts the fall of the elven city to a hushed crowd in the alehouse.",
  },
];

const QUERIES: { text: string; rel: string }[] = [
  { text: "Who is assaulting the fortress with fire from above?", rel: "dragon" },
  { text: "Which character seeks divine strength before a battle?", rel: "knight" },
  { text: "Where do the criminals split up their stolen loot?", rel: "thieves" },
  { text: "What concoction dulls suffering at the cost of clear thought?", rel: "alchemist" },
  { text: "A trader arrives to sell exotic foreign goods.", rel: "merchant" },
  { text: "Who records vessels and watches for tempests by the coast?", rel: "lighthouse" },
  { text: "Guiding a ship safely past dangerous underwater rocks.", rel: "voyage" },
  { text: "A student secretly transcribes prohibited magical symbols.", rel: "apprentice" },
  { text: "Uncovering a hidden scheme to overthrow the monarch.", rel: "spy" },
  { text: "Predators threaten livestock during a snowstorm.", rel: "wolves" },
];

function cosine(a: number[] | Float32Array, b: number[] | Float32Array): number {
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

type Vec = number[] | Float32Array;

function score(label: string, dim: number, docVecs: Vec[], queryVecs: Vec[]): void {
  let hits = 0;
  let rrSum = 0;
  let marginSum = 0;
  for (let q = 0; q < QUERIES.length; q += 1) {
    const qv = queryVecs[q] as Vec;
    const ranked = DOCS.map((d, i) => ({ id: d.id, s: cosine(qv, docVecs[i] as Vec) })).sort(
      (a, b) => b.s - a.s,
    );
    const relId = QUERIES[q]?.rel;
    const rank = ranked.findIndex((r) => r.id === relId) + 1;
    if (rank === 1) hits += 1;
    rrSum += 1 / rank;
    const relScore = ranked.find((r) => r.id === relId)?.s ?? 0;
    const bestDistractor = ranked.find((r) => r.id !== relId)?.s ?? 0;
    marginSum += relScore - bestDistractor;
  }
  const n = QUERIES.length;
  console.log(
    `  ${label.padEnd(28)} dim=${String(dim).padEnd(5)} top1=${((hits / n) * 100).toFixed(0)}% (${hits}/${n}) · MRR=${(rrSum / n).toFixed(3)} · margin=${(marginSum / n).toFixed(3)}`,
  );
}

async function main(): Promise<void> {
  const docTexts = DOCS.map((d) => d.text);
  const queryTexts = QUERIES.map((q) => q.text);

  // --- Our embedder: BGE-M3 in-process (symmetric, as the pipeline runs it) ---
  const t0 = performance.now();
  const bge = createEmbedder();
  const bgeDocs = await bge.embedBatch(docTexts);
  const bgeQueries = await bge.embedBatch(queryTexts);
  const bgeMs = performance.now() - t0;

  // --- Hosted: qwen3-embedding-8b via OpenRouter (asymmetric via inputType) ---
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const client = new OpenRouter({ apiKey });
  const t1 = performance.now();
  const qd = await client.embeddings.generate({
    requestBody: {
      model: QWEN_MODEL,
      input: docTexts,
      encodingFormat: "float",
      inputType: "search_document",
    },
  });
  const qq = await client.embeddings.generate({
    requestBody: {
      model: QWEN_MODEL,
      input: queryTexts,
      encodingFormat: "float",
      inputType: "search_query",
    },
  });
  const qwenMs = performance.now() - t1;
  // biome-ignore lint/suspicious/noExplicitAny: response union (body | string).
  const qwenDocs = ((qd as any).data as { embedding: number[] }[]).map((d) => d.embedding);
  // biome-ignore lint/suspicious/noExplicitAny: response union.
  const qwenQueries = ((qq as any).data as { embedding: number[] }[]).map((d) => d.embedding);
  // biome-ignore lint/suspicious/noExplicitAny: usage cost.
  const qwenCost = (qd as any).usage?.cost + (qq as any).usage?.cost;

  console.log(
    `\nRetrieval eval — ${QUERIES.length} queries over ${DOCS.length} docs (semantic, low lexical overlap)\n`,
  );
  score("BGE-M3 (in-process ONNX)", bgeDocs[0]?.length ?? 0, bgeDocs, bgeQueries);
  score(`qwen3-embedding-8b (OR)`, qwenDocs[0]?.length ?? 0, qwenDocs, qwenQueries);
  console.log("");
  console.log(
    `  wall-clock: BGE-M3 ${bgeMs.toFixed(0)}ms (local, free) · Qwen ${qwenMs.toFixed(0)}ms (network) · Qwen cost ~$${qwenCost?.toFixed(8)}`,
  );
  console.log(
    "  (top1=top-1 accuracy, MRR=mean reciprocal rank, margin=cos(relevant)−best distractor; higher=better)",
  );
}

await main()
  .catch((e: unknown) => {
    console.error("embedder compare failed:", e);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
