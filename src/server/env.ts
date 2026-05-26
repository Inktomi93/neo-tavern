import process from "node:process";
import dotenv from "dotenv";
import { z } from "zod";

// Load a local .env BEFORE parsing. override:true so a checked-in .env (dev) wins over a stale
// shell export (e.g. an old OPENROUTER_API_KEY lingering in the environment). In prod there's no
// .env file, so this is a no-op and the deployment's real env vars stand. .env is gitignored.
dotenv.config({ override: true });

// The ONLY place that touches process.env. Everything else imports `env` and
// reads known, typed keys (env.PORT) — which is dot access on a real property,
// so it satisfies both tsc's noPropertyAccessFromIndexSignature and Biome's
// useLiteralKeys at once. Passing process.env wholesale to .parse() never
// property-accesses the index signature, so neither rule fires here either.
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8788),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // OpenRouter (raw-mode + non-Claude models). Optional until raw mode lands.
  // sdk-mode (Claude) needs NO key here — it authenticates via the host's
  // `claude login` Max subscription; see buildClaudeSdkEnv below.
  OPENROUTER_API_KEY: z.string().min(1).optional(),

  // Observability (see src/server/observability + docs/observability.md).
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Gates the /api/_debug/* introspection API. UNSET = the API is disabled (404).
  // Set it (any value) to enable; requests must present it. Keep unset in prod
  // images unless you actually want the debug surface reachable.
  DEBUG_TOKEN: z.string().min(1).optional(),

  // Database — the libSQL file URL (dev: a local file; prod: the mounted volume).
  DATABASE_URL: z.string().min(1).default("file:./neo-tavern.db"),

  // Embedding ONNX execution provider. "cpu" (default) runs BGE-M3 on the CPU runtime —
  // fine for short query embeds (~0.04s) and the safe default for tests/dev. "cuda" runs
  // the in-process onnxruntime-node CUDA EP (~24× faster on long text — used for the
  // corpus embed pass). CUDA needs the CUDA-12 runtime libs on LD_LIBRARY_PATH (ORT's EP
  // is built for CUDA 12; the host's system CUDA may differ) — see docs/corpus-import.md.
  EMBED_DEVICE: z.enum(["cpu", "cuda"]).default("cpu"),
  // ONNX weight precision. "fp32" (default, required on cpu) or "fp16" — fp16 on CUDA is
  // ~30% faster at the same 1024-dim output; the precision delta is negligible after
  // L2-normalize (cosine of an fp16 vs fp32 embedding of the same text ≈ 0.9999), so a
  // cuda+fp16 corpus index and cpu+fp32 queries share one space. The GPU launcher sets fp16.
  EMBED_DTYPE: z.enum(["fp32", "fp16"]).default("fp32"),
  // Reranker (bge-reranker-v2-m3 cross-encoder, Phase 4.6.3b) ONNX device. "cpu" default
  // (safe for tests/dev); "cuda" for responsive query-time reranking. At query time the
  // embedder (query vector) then reranker run SEQUENTIALLY, so they don't contend — a
  // 2-GPU split (embedder GPU 0, reranker GPU 1 via CUDA_VISIBLE_DEVICES) only matters for
  // concurrent INDEX batch ops, which don't use the reranker. So this stays device-agnostic.
  RERANK_DEVICE: z.enum(["cpu", "cuda"]).default("cpu"),
  // The onnx-community/bge-reranker-v2-m3-ONNX repo ships ONLY fp16 weights (fp32/auto fail
  // — no file), so fp16 is the default for both cpu and cuda (ORT runs fp16 on cpu via fallback).
  RERANK_DTYPE: z.enum(["fp16", "q8"]).default("fp16"),
  // Where transformers.js downloads/caches model weights (BGE-M3, the reranker). Pinned
  // to a repo-local, gitignored dir so model artifacts stay self-contained — not leaking
  // into node_modules/.cache or an OS-global HF cache. Resolved relative to cwd (repo root).
  MODEL_CACHE_DIR: z.string().min(1).default("./.models"),

  // Auth/tenancy (see CLAUDE.md). Identity = X-Authentik-Username, trusted ONLY when
  // caddy forwards it with a matching X-Neo-Proxy secret; otherwise (direct LAN/IP
  // access) we fall back to the owner. UNSET secret = header never trusted = always
  // the default user, which is correct for local dev (no caddy in front).
  DEFAULT_USER_HANDLE: z.string().min(1).default("owner"), // set to your authentik username so both access paths map to one user
  NEO_PROXY_SECRET: z.string().min(1).optional(),
});

export const env = envSchema.parse(process.env);

/**
 * Environment for the Claude Agent SDK subprocess. sdk-mode authenticates with
 * the host's `claude login` (Max subscription) through the official runtime —
 * verified: the probe ran with `apiKeySource=none` and still succeeded. We
 * never set or extract a token (keychain extraction → direct API is what gets
 * accounts banned; learned from st-claude-proxy). Spread process.env so the
 * subprocess keeps PATH/HOME (and thus ~/.claude credentials); drop any
 * ANTHROPIC_API_KEY (it would override the subscription); and keep CLAUDE.md
 * out of every request — must be the string "true", not "1" (st-claude-proxy
 * gotcha: Claude Code's isEnvTruthy() ignores "1").
 */
export function buildClaudeSdkEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "true",
  };
}
