import { performance } from "node:perf_hooks";
import type {
  ChatHistoryItem,
  Llama,
  LlamaChatSession,
  LlamaContext,
  LlamaGrammar,
  LlamaModel,
} from "node-llama-cpp";
import { env } from "../env";
import { getLog } from "../observability/logger";
import { runChatCompletionTurn } from "../providers/openrouter";
import { WarmModel } from "./warm-model";

// Optional in-process local summarizer — a generative model adapter, colocated with the embedder
// and reranker because it shares their WarmModel lifecycle (warm-on-boot, idle-unload, failure-
// reset). Runs node-llama-cpp (llama.cpp) on a local GGUF (e.g. Qwen3-4B-Instruct Q8), so it stays
// in-process and port-free like the others. Used by the {{memory}} digest pipeline (~1 call per N
// turns), NOT a hot path — so node-llama-cpp's lack of in-process GPU pinning is a non-issue
// (placement is its default; CUDA_VISIBLE_DEVICES is the only lever if isolation is ever needed).
//
// OPT-IN: inert unless SUMMARIZER_GGUF is set, so the server never loads node-llama-cpp (or a 4GB
// model) by default. node-llama-cpp is imported dynamically for the same reason.
export const SUMMARIZER_MODEL = "local-gguf";
// Hosted fallback when no local GGUF is configured (or source: "hosted"): Haiku over the EXISTING
// chat-completions runner (runChatCompletionTurn) — no reinvented OpenRouter client. Fixed model.
export const HOSTED_SUMMARIZER_MODEL = "anthropic/claude-haiku-4.5";

export interface SummarizeResult {
  /** The digest text (any <think>…</think> stripped). */
  text: string;
  /** Which model actually produced it — provenance for chat_digests.summarizerModel. */
  model: string;
}

export interface Summarizer {
  /**
   * Generate a digest for `userPrompt` under `systemPrompt`. LOCAL-FIRST: runs the local GGUF when
   * SUMMARIZER_GGUF is set; otherwise falls back to hosted Haiku over the existing chat-completions
   * runner. `source: "hosted"` forces the Haiku fallback. Each call is independent (history reset /
   * fresh request) and thinking is disabled.
   */
  summarize(
    systemPrompt: string,
    userPrompt: string,
    opts?: {
      maxTokens?: number | undefined;
      temperature?: number | undefined;
      source?: "local" | "hosted" | undefined;
      // When set, the LOCAL path constrains output to this JSON schema via a GBNF grammar (the
      // sampler can't emit a non-conforming token). The hosted path relies on the prompt asking
      // for JSON. Either way the returned `text` is the JSON string for the caller to parse.
      jsonSchema?: object | undefined;
    },
  ): Promise<SummarizeResult>;
}

/** True when a local summarizer GGUF is configured (SUMMARIZER_GGUF). */
export function isSummarizerConfigured(): boolean {
  return Boolean(env.SUMMARIZER_GGUF);
}

interface Loaded {
  llama: Llama;
  model: LlamaModel;
  context: LlamaContext;
  session: LlamaChatSession;
  grammars: Map<string, LlamaGrammar>; // JSON-schema grammars, compiled once per (schema, load)
}

// Drop any <think>…</think> the model emits anyway, as a backstop to budgets.thoughtTokens=0.
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

const warm = new WarmModel<Loaded>({
  name: `summarizer@${env.SUMMARIZER_GGUF ?? "unset"}`,
  idleMs: env.IDLE_UNLOAD_MIN * 60_000,
  load: async () => {
    const modelPath = env.SUMMARIZER_GGUF;
    if (!modelPath)
      throw new Error("SUMMARIZER_GGUF is not set; the local summarizer is disabled.");
    // Dynamic import so node-llama-cpp is only loaded when the summarizer is actually configured.
    // Alias the runtime class so it doesn't shadow the type-only `LlamaChatSession` import.
    const { getLlama, LlamaChatSession: ChatSession } = await import("node-llama-cpp");
    // "auto" picks the best backend (CUDA on the homelab, CPU/Vulkan elsewhere) so this also works
    // off-GPU. gpuLayers "max" = full offload; flashAttention = faster + smaller KV for long prompts.
    const llama = await getLlama({ gpu: "auto" });
    const model = await llama.loadModel({
      modelPath,
      gpuLayers: "max",
      defaultContextFlashAttention: true,
    });
    const context = await model.createContext({ contextSize: 16384, batchSize: 2048 });
    const session = new ChatSession({ contextSequence: context.getSequence() });
    return { llama, model, context, session, grammars: new Map() };
  },
  unload: async ({ model, context }) => {
    await context.dispose();
    await model.dispose();
  },
  warm: async ({ session }) => {
    session.resetChatHistory();
    await session.prompt("warm up", { budgets: { thoughtTokens: 0 }, maxTokens: 8 });
  },
});

/** Eagerly load + JIT the summarizer so the first real digest is fast. No-op if not configured. */
export async function warmUpSummarizer(): Promise<void> {
  if (!isSummarizerConfigured()) return;
  await warm.warmUp();
}

export function createSummarizer(): Summarizer {
  return {
    async summarize(systemPrompt, userPrompt, opts) {
      // Local-first: the GGUF unless hosted is explicitly requested or no GGUF is configured.
      if (opts?.source !== "hosted" && isSummarizerConfigured()) {
        const text = await warm.use(async (loaded) => {
          const start = performance.now();
          // Fresh system prompt per call — independent summaries, no prior-turn bleed.
          loaded.session.setChatHistory([
            { type: "system", text: systemPrompt } as ChatHistoryItem,
          ]);
          // JSON-schema grammar (compiled once per schema) → the sampler is CONSTRAINED to the shape,
          // so a small model literally cannot malform the digest (e.g. dump keywords into the anchor).
          let grammar: LlamaGrammar | undefined;
          if (opts?.jsonSchema) {
            const key = JSON.stringify(opts.jsonSchema);
            grammar = loaded.grammars.get(key);
            if (!grammar) {
              // The method's const-generic param is stricter than a runtime object literal; the
              // value IS a valid GbnfJsonSchema (DIGEST_SCHEMA), so cast through.
              grammar = await loaded.llama.createGrammarForJsonSchema(opts.jsonSchema as never);
              loaded.grammars.set(key, grammar);
            }
          }
          const out = await loaded.session.prompt(userPrompt, {
            budgets: { thoughtTokens: 0 }, // disable Qwen3 thinking (no-op on instruct models)
            temperature: opts?.temperature ?? 0.7,
            topP: 0.8,
            topK: 20,
            minP: 0,
            maxTokens: opts?.maxTokens ?? 768,
            ...(grammar ? { grammar } : {}),
          });
          const durationMs = Math.round(performance.now() - start);
          getLog().debug(
            { model: SUMMARIZER_MODEL, promptLength: userPrompt.length, durationMs },
            "summarizer: local generation",
          );
          return stripThink(out);
        });
        return { text, model: SUMMARIZER_MODEL };
      }
      // Hosted fallback — Haiku over the existing chat-completions runner (reuse, don't reinvent).
      // thinking:"off" ⇒ no reasoning block is sent; Haiku replies in-character immediately.
      const start = performance.now();
      const turn = await runChatCompletionTurn({
        model: HOSTED_SUMMARIZER_MODEL,
        systemPrompt: { static: systemPrompt, dynamic: "" },
        history: [{ role: "user", content: userPrompt }],
        generation: {
          thinking: "off",
          temperature: opts?.temperature ?? 0.3,
          maxOutputTokens: opts?.maxTokens ?? 768,
        },
      });
      const durationMs = Math.round(performance.now() - start);
      getLog().debug(
        { model: HOSTED_SUMMARIZER_MODEL, promptLength: userPrompt.length, durationMs },
        "summarizer: hosted generation",
      );
      return { text: stripThink(turn.reply), model: HOSTED_SUMMARIZER_MODEL };
    },
  };
}
