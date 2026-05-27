import { performance } from "node:perf_hooks";
import process from "node:process";
import { OpenRouter } from "@openrouter/sdk";
import { env } from "../src/server/env";

/**
 * OpenRouter (hosted) embed + rerank cost/speed probe — the API counterpart to the in-process
 * ONNX/llama.cpp probes. Measures wall-clock latency (includes network round-trip) AND the
 * real billed cost (`usage.cost`, in credits=USD) for:
 *   • embeddings.generate — single + batch(32), per model
 *   • rerank.rerank       — 1 query × N docs
 *
 * baai/bge-m3 is the SAME model we run in-process → true apples-to-apples (cost of hosting vs
 * our free GPU). qwen3-embedding-8b is the big decoder we *can't* run efficiently on ONNX.
 *
 *   pnpm tsx scripts/openrouter-embed-rerank-probe.ts
 */
const EMBED_MODELS = (process.env["EMBED_MODELS"] ?? "baai/bge-m3,qwen/qwen3-embedding-8b").split(
  ",",
);
// cohere/rerank-4-fast → Cohere rerank-v4.0-fast (32k-token chunks); cohere/rerank-v3.5 (4093-tok).
const RERANK_MODELS = (
  process.env["RERANK_MODELS"] ?? "cohere/rerank-v3.5,cohere/rerank-4-fast"
).split(",");

const ms = (n: number): string => `${n.toFixed(0)}ms`;
const usd = (n: number | undefined): string => (n === undefined ? "n/a" : `$${n.toFixed(8)}`);

const SENTENCES = [
  "The dragon breathed fire over the castle walls.",
  "A wyrm scorched the fortress ramparts with flame.",
  "The knight raised her shield against the searing heat.",
  "Embers drifted across the moonlit courtyard.",
  "She sheathed her blade and turned toward the gate.",
  "I reconciled the quarterly budget spreadsheet.",
];

function cosine(a: number[], b: number[]): number {
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

async function embedTest(client: OpenRouter, model: string): Promise<void> {
  console.log(`\n=== EMBED · ${model} ===`);

  // Single embed × 3 reps (network latency varies → report min/avg).
  const singleLat: number[] = [];
  let singleCost = 0;
  let dim = 0;
  let firstVec: number[] = [];
  let relVec: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    const res = await client.embeddings.generate({
      requestBody: { model, input: SENTENCES[0] as string, encodingFormat: "float" },
    });
    singleLat.push(performance.now() - t0);
    // biome-ignore lint/suspicious/noExplicitAny: response union (body | string).
    const body = res as any;
    const vec = body?.data?.[0]?.embedding;
    if (Array.isArray(vec)) {
      dim = vec.length;
      if (i === 0) firstVec = vec as number[];
    }
    singleCost = body?.usage?.cost ?? singleCost;
  }
  const singleAvg = singleLat.reduce((s, n) => s + n, 0) / singleLat.length;

  // Batch(32) in ONE request (server-side batch).
  const batchInput = Array.from(
    { length: 32 },
    (_, i) => `${SENTENCES[i % SENTENCES.length]} (#${i})`,
  );
  const tB = performance.now();
  const bres = await client.embeddings.generate({
    requestBody: { model, input: batchInput, encodingFormat: "float" },
  });
  const batchLat = performance.now() - tB;
  // biome-ignore lint/suspicious/noExplicitAny: response union.
  const bbody = bres as any;
  const batchCount = bbody?.data?.length ?? 0;
  const batchCost: number | undefined = bbody?.usage?.cost;
  const batchTokens: number | undefined = bbody?.usage?.totalTokens ?? bbody?.usage?.total_tokens;

  // Correctness sanity: embed a related sentence, compare to firstVec.
  const rres = await client.embeddings.generate({
    requestBody: { model, input: SENTENCES[1] as string, encodingFormat: "float" },
  });
  // biome-ignore lint/suspicious/noExplicitAny: response union.
  relVec = ((rres as any)?.data?.[0]?.embedding as number[]) ?? [];

  console.log(`  dim            = ${dim}`);
  console.log(
    `  single embed   = ${ms(singleAvg)} avg · ${ms(Math.min(...singleLat))} min  · cost ${usd(singleCost)}`,
  );
  console.log(
    `  batch(32)      = ${ms(batchLat)} total · ${ms(batchLat / 32)}/text · ${batchCount} vecs · ${batchTokens ?? "?"} tok · cost ${usd(batchCost)}`,
  );
  if (batchCost !== undefined && batchTokens) {
    console.log(`  → $/1M tokens  = $${((batchCost / batchTokens) * 1_000_000).toFixed(4)}`);
  }
  if (firstVec.length && relVec.length) {
    console.log(`  sim related    = ${cosine(firstVec, relVec).toFixed(3)}`);
  }
}

// Cohere best practice: semi-structured docs are passed as YAML strings with key order
// PRESERVED (truncation drops trailing keys), so put the most salient field first. Our RP
// rerank candidates are exactly this shape — a chat message with speaker/scene metadata.
function yamlDoc(i: number): string {
  const text = SENTENCES[i % SENTENCES.length] as string;
  return `text: ${text}\nspeaker: ${i % 2 === 0 ? "Narrator" : "Knight"}\nscene: castle siege\nseq: ${i}`;
}

async function rerankTest(client: OpenRouter, model: string, docCount: number): Promise<void> {
  // Cohere best practices applied: rerank a retrieval SHORTLIST (not the corpus); docs as
  // ordered YAML; explicit top_n; v3.5 self-chunks at 4093 tok / query ≤2048 tok (our short
  // docs never hit it). Billed per search unit (≤100 docs ≈ 1 unit).
  const query = "Who breathed fire at the castle?";
  const docs = Array.from({ length: docCount }, (_, i) => yamlDoc(i));

  const lat: number[] = [];
  let cost: number | undefined;
  let units: number | undefined;
  let top: { index: number; score: number } | undefined;
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    const res = await client.rerank.rerank({
      requestBody: { model, query, documents: docs, topN: 5 },
    });
    lat.push(performance.now() - t0);
    // biome-ignore lint/suspicious/noExplicitAny: response union.
    const body = res as any;
    cost = body?.usage?.cost ?? cost;
    units = body?.usage?.searchUnits ?? body?.usage?.search_units ?? units;
    const r0 = body?.results?.[0];
    if (r0) top = { index: r0.index, score: r0.relevanceScore ?? r0.relevance_score };
  }
  const avg = lat.reduce((s, n) => s + n, 0) / lat.length;
  console.log(
    `  rerank(1q×${docCount}d, YAML) = ${ms(avg)} avg · ${ms(Math.min(...lat))} min · cost ${usd(cost)} (${units ?? "?"} unit) · top=doc#${top?.index} ${top?.score?.toFixed(3)}`,
  );
}

async function main(): Promise<void> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const client = new OpenRouter({ apiKey });

  for (const m of EMBED_MODELS) await embedTest(client, m.trim());
  for (const rm of RERANK_MODELS) {
    console.log(`\n=== RERANK · ${rm.trim()} (Cohere best-practice: YAML docs, top_n=5) ===`);
    for (const n of [10, 100]) await rerankTest(client, rm.trim(), n);
  }
}

await main()
  .catch((e: unknown) => {
    console.error("openrouter probe failed:", e);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
