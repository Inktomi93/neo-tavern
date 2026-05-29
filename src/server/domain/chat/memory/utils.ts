import { DEFAULTS } from "./constants";
import type { MemoryConfig, MsgRow } from "./types";

export function resolveCfg(p: MemoryConfig) {
  return {
    enabled: p.enabled ?? false,
    blockSize: p.blockSize ?? DEFAULTS.blockSize,
    verbatimWindow: p.verbatimWindow ?? DEFAULTS.verbatimWindow,
    queryWindow: p.queryWindow ?? DEFAULTS.queryWindow,
    mode: p.mode ?? DEFAULTS.mode,
    fanOut: p.fanOut ?? DEFAULTS.fanOut,
    maxTier: p.maxTier ?? DEFAULTS.maxTier,
    retrieveK: p.retrieveK ?? DEFAULTS.retrieveK,
    rerankTo: p.rerankTo ?? DEFAULTS.rerankTo,
    minScore: p.minScore ?? DEFAULTS.minScore,
    keywordMatch: p.keywordMatch ?? DEFAULTS.keywordMatch,
    recencyBias: p.recencyBias ?? DEFAULTS.recencyBias,
    summarizerSource: p.summarizer?.source,
    summarizerMaxTokens: p.summarizer?.maxTokens,
    summarizerTemperature: p.summarizer?.temperature,
  };
}

// ── prompts ──────────────────────────────────────────────────────────────────

// Tier-0: structured, INDEPENDENT (no prior-digest chain). Topic anchor (CharMemory's precision
// step-change) + significance-filtered facts ("mentioned later?" litmus) + concrete keywords
// (MemoryBooks). The structure is the retrieval signal.
// JSON schema for grammar-constrained digests. On the LOCAL path this is compiled to a GBNF grammar
// so the sampler CANNOT malform the shape (the b21/b24 keyword-dump-in-the-anchor failure becomes
// impossible); the hosted path asks for the same JSON in the prompt. parseDigest reads it (free-text
// fallback for safety / the fake test summarizer).
export function renderTranscript(block: MsgRow[], charName: string, userName: string): string {
  return block
    .map((m) => `${m.role === "user" ? userName : charName}: ${m.content.trim()}`)
    .join("\n\n");
}

// Parse the model's structured output → the stored fields. Lenient: a missing KEYWORDS line just
// yields no keywords; the topic anchor falls back to the first non-empty line.
export function parseDigest(raw: string): {
  text: string;
  topicAnchor: string | null;
  keywords: string[];
} {
  const trimmed = raw.trim();
  // JSON-first: the local path is grammar-constrained to DIGEST_SCHEMA, the hosted path is prompted
  // for the same JSON. Slice the outermost {...} so stray prose around it is tolerated.
  const js = trimmed.indexOf("{");
  const je = trimmed.lastIndexOf("}");
  if (js !== -1 && je > js) {
    try {
      const o = JSON.parse(trimmed.slice(js, je + 1)) as {
        topicAnchor?: unknown;
        facts?: unknown;
        keywords?: unknown;
      };
      const anchor = typeof o.topicAnchor === "string" ? o.topicAnchor.trim() : null;
      const facts = Array.isArray(o.facts)
        ? o.facts.filter((f): f is string => typeof f === "string")
        : [];
      const keywords = Array.isArray(o.keywords)
        ? o.keywords
            .filter((k): k is string => typeof k === "string")
            .map((k) => k.trim())
            .filter(Boolean)
        : [];
      if (anchor || facts.length > 0) {
        // Reconstruct the stored/embedded text from the structured fields (anchor + bullet facts).
        const text = [anchor, ...facts.map((f) => `- ${f}`)].filter(Boolean).join("\n");
        return { text, topicAnchor: anchor, keywords };
      }
    } catch {
      // malformed JSON → fall through to the free-text parser
    }
  }
  // The model was emitting JSON ("{…") but it didn't parse (truncated/garbled) — skip rather than
  // store a broken "{…" anchor. generateDigests drops empty digests and regenerates them later.
  if (trimmed.startsWith("{")) return { text: "", topicAnchor: null, keywords: [] };
  // Free-text fallback (the legacy "[anchor]\n- fact\nKEYWORDS: …" shape) — hosted output that
  // ignored the JSON ask, or the deterministic fake summarizer in tests.
  const lines = trimmed.split("\n");
  const kwIdx = lines.findIndex((l) => /^\s*keywords\s*:/i.test(l));
  let keywords: string[] = [];
  if (kwIdx !== -1) {
    keywords = (lines[kwIdx] ?? "")
      .replace(/^\s*keywords\s*:/i, "")
      .split(/[,;]/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
  }
  const bodyLines = kwIdx === -1 ? lines : lines.slice(0, kwIdx);
  const text = bodyLines.join("\n").trim();
  const anchorLine = bodyLines.find((l) => l.trim().length > 0)?.trim() ?? null;
  return { text, topicAnchor: anchorLine, keywords };
}

// Cosine of two L2-normalized vectors = their dot product (the embedder normalizes).
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

// Chunk an ordered array into fixed-size blocks; the final block may be short (it grows and
// re-digests as more messages age out).
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
