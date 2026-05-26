import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 *
 * Generation knobs are set EXPLICITLY (not inherited): `...process.env` would otherwise leak the
 * host's ambient `CLAUDE_EFFORT` (currently "xhigh") into every chat, making behavior depend on the
 * shell. All verified via `scripts/env-knob-probe.ts`. Owner-chosen RP defaults:
 *   • thinking OFF (`CLAUDE_CODE_DISABLE_THINKING`) — the model writes in-character immediately, no
 *     reasoning preamble, far fewer tokens.
 *   • Opus capped at 200k (`CLAUDE_CODE_DISABLE_1M_CONTEXT`) — compacts/manages sooner, cheaper/turn
 *     (Opus 4.7 defaults to a 1M window otherwise); also makes the context-fill meter denominator 200k.
 *   • `CLAUDE_EFFORT` neutralized — moot with thinking off, but explicit kills the ambient leak.
 * These are flat defaults today; a per-chat override (preset config → per-turn env) is a later step.
 */
export function buildClaudeSdkEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: undefined,
    // Explicitly null the OpenRouter-skin trio so a stale ambient export (or a future
    // mode-2 bug) can NEVER repoint the FREE Max-sub subprocess at a paid base URL +
    // alien auth token — which would route the sub's OAuth token off to a third party
    // (the st-claude-proxy ban shape). Sub mode authenticates via the host `claude
    // login` ONLY; these three must not leak in. (Mirrors the CLAUDE_EFFORT discipline.)
    ANTHROPIC_BASE_URL: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "true",
    CLAUDE_CODE_DISABLE_THINKING: "1",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    CLAUDE_EFFORT: undefined,
  };
}

// Mode-2 ("Claude API") credential isolation. The Agent SDK resolves its config/credential
// dir from CLAUDE_CONFIG_DIR (and, separately, ANTHROPIC_CONFIG_DIR), each defaulting to
// ~/.claude where the host `claude login` token lives (file-based: ~/.claude/.credentials.json,
// verified). Pointing BOTH at a fresh empty dir makes that token physically unreachable by the
// spawn — so a mode-2 subprocess, which DOES set a paid base URL, can never send the Max-sub
// OAuth token to OpenRouter. Memoized: one ephemeral dir per process (the SDK only writes its
// transient session JSONL there; our DB-backed SessionStore is canon, so emptiness is fine).
let isolatedConfigDir: string | undefined;
function ephemeralClaudeConfigDir(): string {
  if (isolatedConfigDir === undefined) {
    isolatedConfigDir = mkdtempSync(join(tmpdir(), "neo-tavern-claude-or-"));
  }
  return isolatedConfigDir;
}

/**
 * Environment for "Claude API" mode (mode 2 of the 4-mode architecture): the SAME Agent SDK
 * runner, env-swapped to route through OpenRouter's Anthropic-compatible skin — paid Claude
 * that REUSES our entire sdk-mode pipeline (caching/thinking/events/seeding/swipes), only the
 * subprocess auth target differs. The skin recipe (per OpenRouter's Claude Code integration):
 * `ANTHROPIC_BASE_URL` → OpenRouter, `ANTHROPIC_AUTH_TOKEN` → the OpenRouter key, and
 * `ANTHROPIC_API_KEY` set to the EMPTY STRING (not unset — an unset key lets the runtime fall
 * through to other credential sources).
 *
 * SECURITY (the ban-risk firewall): this spawn sets a paid base URL, so the host `claude login`
 * token MUST NOT be reachable from it. We (1) isolate CLAUDE_CONFIG_DIR + ANTHROPIC_CONFIG_DIR to
 * an empty ephemeral dir (hides ~/.claude/.credentials.json) and (2) null every OTHER credential
 * source the runtime reads (OAuth token, identity tokens, service account). The ONLY credential in
 * scope becomes the OpenRouter auth token — making it structurally impossible to leak the sub
 * token to OpenRouter, regardless of the runtime's internal credential precedence.
 *
 * Takes the key as an argument (required, non-empty) rather than reading it here, so the function
 * is pure + unit-testable and the "key required" invariant is explicit at the call site.
 */
export function buildClaudeOpenRouterEnv(
  openRouterApiKey: string,
): Record<string, string | undefined> {
  if (!openRouterApiKey) {
    throw new Error(
      "buildClaudeOpenRouterEnv: an OpenRouter API key is required for Claude-API mode (the Anthropic skin).",
    );
  }
  const configDir = ephemeralClaudeConfigDir();
  return {
    ...process.env,
    // Same leak-discipline + RP generation defaults as sub mode, so the ONLY difference between
    // mode 1 and mode 2 is the auth target (keeps both turns byte-comparable for caching).
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "true",
    CLAUDE_CODE_DISABLE_THINKING: "1",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    CLAUDE_EFFORT: undefined,
    // The OpenRouter Anthropic-skin trio.
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: openRouterApiKey,
    // Tier → OpenRouter Claude id mapping (the runtime asks for opus/sonnet/haiku tiers).
    ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.7",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-4.6",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5",
    // Credential isolation — the firewall (see the SECURITY note above).
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_CONFIG_DIR: configDir,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_IDENTITY_TOKEN: undefined,
    ANTHROPIC_IDENTITY_TOKEN_FILE: undefined,
    ANTHROPIC_SERVICE_ACCOUNT_ID: undefined,
  };
}
