import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { createEmbedder } from "../src/server/embeddings/embedder";
import { createReranker } from "../src/server/embeddings/reranker";
import { env } from "../src/server/env";

/**
 * {{memory}} digest-pipeline DEMO over a real long SillyTavern chat (the 222-msg Bess chat).
 * Implements docs/memory.md's design with the validated hybrid runtime:
 *   • Summarizer → OpenRouter Qwen (chat.send), DELTA digests (each sees prior digests → no repeats).
 *     Delta = sequential by nature; that's the accepted cost of better compression.
 *   • Embedder + Reranker → warm-local transformers.js/ONNX (BGE-M3 + bge-reranker-v2-m3). The
 *     digest embeddings are done in ONE batched embedBatch() pass; the reranker batches its pool.
 *
 * BUILD once, QUERY many — the artifact (digests + vectors + cost) is persisted so you can test
 * arbitrary queries without re-summarizing/re-embedding:
 *   pnpm tsx scripts/memory-demo.ts build
 *   pnpm tsx scripts/memory-demo.ts show
 *   pnpm tsx scripts/memory-demo.ts query "what does Bess build?" "Nate and Bess's history"
 */
const CHAT_FILE =
  process.env["CHAT_FILE"] ??
  "corpus-staging/default-user/chats/Bess/Bess - 2026-02-16@21h32m01s349ms.jsonl";
const ARTIFACT = process.env["ARTIFACT"] ?? ".models/memory-demo/bess-digests.json";
// Summarizer backend: remote (OpenRouter) by default, OR local in-process node-llama-cpp when
// LOCAL_GGUF is set (e.g. a Qwen3.5-4B bf16 GGUF) — llama.cpp runs the decoder's GQA in fused
// kernels, sidestepping the ONNX repeat_kv fragmentation, in-process on the GPU with no port.
const SUMMARIZER_MODEL = process.env["SUMMARIZER_MODEL"] ?? "anthropic/claude-haiku-4.5";
const LOCAL_GGUF = process.env["LOCAL_GGUF"]; // set → use node-llama-cpp instead of OpenRouter
const BLOCK_N = Number(process.env["BLOCK_N"] ?? "16"); // messages per digest
const VERBATIM = Number(process.env["VERBATIM"] ?? "30"); // recent msgs kept raw (not digested)
const RETRIEVE_K = Number(process.env["RETRIEVE_K"] ?? "8"); // vector candidate pool
const RERANK_TO = Number(process.env["RERANK_TO"] ?? "3"); // final after rerank

interface Msg {
  seq: number;
  role: "user" | "assistant";
  name: string;
  text: string;
}
interface Digest {
  idx: number;
  seqStart: number;
  seqEnd: number;
  text: string;
  tokens: number; // summarizer completion tokens (the digest's real size)
  vector: number[]; // 1024-dim BGE-M3
}
interface Artifact {
  chat: string;
  builtAt: number;
  summarizer: string;
  embedder: string;
  totalMsgs: number;
  verbatimFromSeq: number;
  buildCostUsd: number;
  buildMs: number;
  digests: Digest[];
}

const ms = (n: number): string => `${n.toFixed(0)}ms`;

function parseChat(path: string): Msg[] {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const msgs: Msg[] = [];
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if ("chat_metadata" in obj) continue; // header line
    if (obj["is_system"] === true) continue;
    const text = typeof obj["mes"] === "string" ? obj["mes"].trim() : "";
    if (text.length === 0) continue;
    msgs.push({
      seq: msgs.length,
      role: obj["is_user"] === true ? "user" : "assistant",
      name: typeof obj["name"] === "string" ? obj["name"] : "?",
      text,
    });
  }
  return msgs;
}

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

function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

const SYS_PROMPT =
  "You are a memory summarizer for a roleplay. Given the digests of everything earlier and a NEW " +
  "block of conversation, write ONE dense paragraph (3–6 sentences) capturing ONLY what is NEW in " +
  "this block: events, revelations, relationship shifts, decisions, and concrete facts (names, " +
  "objects, places). Do NOT repeat anything already covered by the prior digests. Third person, " +
  "past tense. Output only the paragraph — no preamble, no headings, no <think> or reasoning.";

function buildUserPrompt(prior: string[], block: Msg[]): string {
  const transcript = block.map((m) => `${m.name}: ${m.text}`).join("\n\n");
  const priorText =
    prior.length > 0 ? prior.map((d, i) => `[${i}] ${d}`).join("\n") : "(none — this is the start)";
  return `PRIOR DIGESTS (already known — do NOT repeat):\n${priorText}\n\nNEW BLOCK — messages ${block[0]?.seq}–${block[block.length - 1]?.seq}:\n${transcript}\n\nDigest of the NEW BLOCK only:`;
}

interface Summarizer {
  label: string;
  summarize(prior: string[], block: Msg[]): Promise<{ text: string; cost: number; tokens: number }>;
  dispose(): Promise<void>;
}

// Remote: OpenRouter via raw fetch (NOT @openrouter/sdk). Hybrid Qwen models need
// `reasoning:{enabled:false}` to suppress thinking, and the SDK's chat schema strips `enabled`
// (BaseReasoningConfig = effort/summary only) → it thinks, burns the budget, returns content:null.
// Haiku ignores the flag harmlessly (non-thinking by default).
function createRemoteSummarizer(apiKey: string): Summarizer {
  return {
    label: SUMMARIZER_MODEL,
    async summarize(prior, block) {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: SUMMARIZER_MODEL,
          messages: [
            { role: "system", content: SYS_PROMPT },
            { role: "user", content: buildUserPrompt(prior, block) },
          ],
          temperature: 0.3,
          max_tokens: 400,
          reasoning: { enabled: false },
        }),
      });
      if (!res.ok) throw new Error(`summarizer ${res.status}: ${(await res.text()).slice(0, 200)}`);
      // biome-ignore lint/suspicious/noExplicitAny: raw API JSON.
      const j = (await res.json()) as any;
      const text = stripThink(
        typeof j?.choices?.[0]?.message?.content === "string" ? j.choices[0].message.content : "",
      );
      return { text, cost: j?.usage?.cost ?? 0, tokens: j?.usage?.completion_tokens ?? 0 };
    },
    async dispose() {},
  };
}

// Local: node-llama-cpp (llama.cpp) in-process on the GPU. One warm model+context+session;
// resetChatHistory() resets to the initial state (keeps the system prompt) so each delta digest
// is independent (no carryover). Thinking is disabled via budgets.thoughtTokens=0 (the proper
// lever — Qwen3.5 dropped the /no_think soft switch; on an instruct model it's a harmless no-op).
async function createLocalSummarizer(ggufPath: string): Promise<Summarizer> {
  const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
  const llama = await getLlama({ gpu: "cuda" });
  // Perf knobs: gpuLayers "max" = offload ALL layers to the GPU (a 4B bf16 ~8GB fits an A6000
  // easily); flashAttention = faster attention + smaller KV cache (big win for our long ~8k-token
  // summarization prompts); batchSize 2048 = ingest the prompt in fewer, larger decode chunks
  // (default 512). Pin to ONE GPU via CUDA_VISIBLE_DEVICES=0 to avoid the multi-GPU
  // pipeline-parallel overhead (graph-reuse-disabled) we measured in the embedding test.
  const model = await llama.loadModel({
    modelPath: ggufPath,
    gpuLayers: "max",
    defaultContextFlashAttention: true,
  });
  // 32768 leaves headroom over the heaviest Bess block (~8.7k tok) + prior digests + generation.
  const context = await model.createContext({ contextSize: 32768, batchSize: 2048 });
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: SYS_PROMPT,
  });
  return {
    label: `local:${ggufPath.split("/").pop()}`,
    async summarize(prior, block) {
      session.resetChatHistory();
      // Sampling = Qwen's recommended non-thinking general-task preset; greedy (temp 0) is discouraged.
      const out = await session.prompt(buildUserPrompt(prior, block), {
        budgets: { thoughtTokens: 0 },
        temperature: 0.7,
        topP: 0.8,
        topK: 20,
        minP: 0,
        maxTokens: 400,
      });
      const text = stripThink(out);
      return { text, cost: 0, tokens: model.tokenize(text).length };
    },
    async dispose() {
      await context.dispose();
      await model.dispose();
    },
  };
}

async function build(): Promise<void> {
  const t0 = performance.now();
  const msgs = parseChat(CHAT_FILE);
  const older = msgs.slice(0, Math.max(0, msgs.length - VERBATIM));
  const verbatimFromSeq = older.length;
  console.log(
    `parsed ${msgs.length} msgs · summarizing ${older.length} older in ${BLOCK_N}-msg blocks · last ${VERBATIM} stay verbatim`,
  );

  let summarizer: Summarizer;
  if (LOCAL_GGUF) {
    console.log(`summarizer: LOCAL node-llama-cpp · ${LOCAL_GGUF} (in-process GPU, free)`);
    summarizer = await createLocalSummarizer(LOCAL_GGUF);
  } else {
    const apiKey = env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
    console.log(`summarizer: REMOTE OpenRouter · ${SUMMARIZER_MODEL}`);
    summarizer = createRemoteSummarizer(apiKey);
  }

  // DELTA digests — sequential (each call sees prior digests so it only records what's new).
  const prior: string[] = [];
  const built: { seqStart: number; seqEnd: number; text: string; tokens: number }[] = [];
  let cost = 0;
  for (let b = 0; b < older.length; b += BLOCK_N) {
    const block = older.slice(b, b + BLOCK_N);
    const tS = performance.now();
    const r = await summarizer.summarize(prior, block);
    prior.push(r.text);
    cost += r.cost;
    built.push({
      seqStart: block[0]?.seq ?? b,
      seqEnd: block[block.length - 1]?.seq ?? b,
      text: r.text,
      tokens: r.tokens,
    });
    console.log(
      `  digest ${built.length} (seq ${block[0]?.seq}–${block[block.length - 1]?.seq}): ${r.tokens} tok · $${r.cost.toFixed(6)} · ${ms(performance.now() - tS)}`,
    );
  }
  await summarizer.dispose();

  // Embed ALL digests in ONE batched local pass (the 40× ONNX batch lever).
  const embedder = createEmbedder();
  const tE = performance.now();
  const vecs = await embedder.embedBatch(built.map((d) => d.text));
  console.log(
    `  embedded ${built.length} digests in one batch: ${ms(performance.now() - tE)} (local, free)`,
  );

  const artifact: Artifact = {
    chat: CHAT_FILE,
    builtAt: Date.now(),
    summarizer: summarizer.label,
    embedder: embedder.model,
    totalMsgs: msgs.length,
    verbatimFromSeq,
    buildCostUsd: cost,
    buildMs: performance.now() - t0,
    digests: built.map((d, i) => ({
      idx: i,
      ...d,
      vector: Array.from(vecs[i] ?? new Float32Array()),
    })),
  };
  mkdirSync(dirname(ARTIFACT), { recursive: true });
  writeFileSync(ARTIFACT, JSON.stringify(artifact));
  const memTokens = built.reduce((s, d) => s + d.tokens, 0);
  console.log(
    `\n✅ built ${built.length} digests · memory = ${memTokens} tok (Mix A fits wholesale) · summarizer $${cost.toFixed(6)} · ${ms(artifact.buildMs)} → ${ARTIFACT}`,
  );
}

function load(): Artifact {
  return JSON.parse(readFileSync(ARTIFACT, "utf8")) as Artifact;
}

function show(): void {
  const a = load();
  const memTokens = a.digests.reduce((s, d) => s + d.tokens, 0);
  console.log(
    `# ${a.chat}\n# ${a.digests.length} digests · ${memTokens} tok · summarizer ${a.summarizer} ($${a.buildCostUsd.toFixed(6)}) · embedder ${a.embedder}\n`,
  );
  console.log("===== Mix A: all digests, chronological (the 'story so far' block) =====\n");
  for (const d of a.digests) console.log(`[seq ${d.seqStart}–${d.seqEnd}] ${d.text}\n`);
}

async function query(queries: string[]): Promise<void> {
  const a = load();
  const embedder = createEmbedder();
  const reranker = createReranker();
  console.log(
    `loaded ${a.digests.length} digests · running ${queries.length} quer${queries.length === 1 ? "y" : "ies"} (embedder+reranker warm-local)\n`,
  );

  for (const q of queries) {
    const tq = performance.now();
    const qv = Array.from(await embedder.embed(q));
    // Stage 1: vector recall (cosine over prebuilt digest vectors).
    const ranked = a.digests
      .map((d) => ({ d, s: cosine(qv, d.vector) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, RETRIEVE_K);
    // Stage 2: local cross-encoder rerank of the candidate pool.
    const hits = await reranker.rerank(
      q,
      ranked.map((r) => ({ id: String(r.d.idx), text: r.d.text })),
    );
    const top = hits.slice(0, RERANK_TO);
    console.log(`Q: "${q}"   (${ms(performance.now() - tq)}, local/free)`);
    console.log(
      `  vector top${RETRIEVE_K}: ${ranked.map((r) => `seq${r.d.seqStart}-${r.d.seqEnd}(${r.s.toFixed(2)})`).join(", ")}`,
    );
    for (const h of top) {
      const d = a.digests[Number(h.id)];
      console.log(
        `  → [rerank ${h.score.toFixed(2)}] seq ${d?.seqStart}–${d?.seqEnd}: ${d?.text.slice(0, 160)}…`,
      );
    }
    console.log("");
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "build";
  if (mode === "build") await build();
  else if (mode === "show") show();
  else if (mode === "query") {
    const qs = process.argv.slice(3);
    if (qs.length === 0)
      throw new Error('usage: memory-demo.ts query "question one" "question two" …');
    await query(qs);
  } else throw new Error(`unknown mode "${mode}" (build | show | query)`);
}

await main()
  .catch((e: unknown) => {
    console.error("memory-demo failed:", e);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
