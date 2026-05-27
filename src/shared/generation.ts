import { z } from "zod";

// The SINGLE provider-agnostic generation-knob vocabulary. One source of truth (lives in the preset
// `config.params`); each runner translates it to its native surface:
//   • agent-sdk  → typed SDK Options (`thinking`, `effort`, `maxBudgetUsd`) + a couple env vars
//                  (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_DISABLE_THINKING`).
//   • openrouter → chat-completions/responses request params + a `reasoning` block.
// A knob a given runner can't honor is a NO-OP there (documented per field), never an error — so a
// preset stays portable across modes. This is what kills the "different params shape per runner" mess.

// Reasoning depth. Mirrors the Agent SDK's EffortLevel exactly (so it passes through untranslated).
// MODEL-GATED on agent-sdk (the SDK clamps unsupported levels): `xhigh` = Opus 4.7 only; `max` =
// Opus 4.6/4.7 + Sonnet 4.6. OpenRouter's effort enum lacks `max`, so the openrouter runner maps
// `max` → `xhigh`. Only meaningful when thinking is on.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const effortLevelSchema = z.enum(EFFORT_LEVELS);

export const generationParamsSchema = z.object({
  // Sampling — OPENROUTER-ONLY. The agent-sdk runtime owns sampling and exposes no temperature/topP
  // knob, so these are no-ops in modes 1 & 2.
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  // Reply ceiling — BOTH runners (agent-sdk: CLAUDE_CODE_MAX_OUTPUT_TOKENS; openrouter: the request
  // field). Don't set absurdly low (64 errored to empty on agent-sdk — docs/sdk-notes.md).
  maxOutputTokens: z.number().int().positive().optional(),
  // Reasoning — BOTH runners (different mechanisms). `thinking` is the on/off toggle: "off" disables,
  // "adaptive" lets the model decide depth (guided by `effort`). `thinkingBudgetTokens`, when set,
  // pins a FIXED reasoning budget (agent-sdk `thinking:{type:'enabled'}`); ignored by openrouter
  // chat (no budget field). Setting `effort` alone implies thinking on (unless thinking is "off").
  thinking: z.enum(["off", "adaptive"]).optional(),
  thinkingBudgetTokens: z.number().int().positive().optional(),
  effort: effortLevelSchema.optional(),
  // Hard per-turn cost cap — AGENT-SDK-ONLY (typed `maxBudgetUsd`; returns error_max_budget_usd).
  // The openrouter runner has no per-request budget, so it's a no-op there.
  maxBudgetUsd: z.number().positive().optional(),
  // Compaction — AGENT-SDK-ONLY (the openrouter runner is stateless, rebuilt from canon, so there's
  // nothing to compact). `thresholdPct` is the context-fill fraction (0.5–0.99) that drives it.
  //   • "auto" (default) — the SDK's own auto-compaction; thresholdPct tunes WHEN it fires
  //     (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).
  //   • "managed" — DISABLE_AUTO_COMPACT + WE auto-fire a steered `/compact` after a turn once fill
  //     crosses thresholdPct (default 0.85), so the next turn starts smaller. RP-grade vs the SDK's
  //     generic summary; opt-in (so no surprise spend on the default).
  //   • "off" — DISABLE_AUTO_COMPACT, never auto-fire; the owner triggers `chat.compact` manually.
  // `instructions` steers the /compact prompt (managed + manual); falls back to an RP-tuned default.
  compaction: z
    .object({
      mode: z.enum(["auto", "managed", "off"]).optional(),
      thresholdPct: z.number().min(0.5).max(0.99).optional(),
      instructions: z.string().optional(),
    })
    .optional(),
  // Memory — within-chat structured-digest recall (docs/memory.md). Runner-AGNOSTIC: fills the
  // {{memory}} marker in the DYNAMIC (cache-safe) half, so it works in every mode and coexists with
  // compaction (orthogonal — memory reaches back past the window compaction drops). When `enabled`,
  // domain/chat digests OLDER messages (per `blockSize`-message blocks, once aged below
  // `verbatimWindow`), embeds each digest, and injects them (Mix A = all chronological; the vector/
  // keyword/rerank gear engages as the list outgrows budget; `tiered` consolidates). Knobs are
  // .describe()'d for the future preset-editor UI.
  memory: z
    .object({
      enabled: z
        .boolean()
        .optional()
        .describe("Turn on within-chat digest memory for this preset."),
      blockSize: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Messages per tier-0 digest block (default 8; ≈3k BGE tok, under the 8192 cap)."),
      verbatimWindow: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Recent messages never digested — the protect zone / seam buffer (default 8)."),
      queryWindow: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Recent messages used as the retrieval query for mixB/mixC (default 2)."),
      mode: z
        .enum(["off", "mixA", "mixB", "mixC", "tiered"])
        .optional()
        .describe(
          "off | mixA (all tier-0, chronological) | mixB (+vector retrieve) | mixC (+rerank) | tiered (consolidation bridge). Default mixC (flat query-driven RAG).",
        ),
      fanOut: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Tier-k digests consolidated into one tier-(k+1) digest (default 4)."),
      maxTier: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Max consolidation depth; 0 = tier-0 only (default 3)."),
      retrieveK: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Vector candidate pool size for mixB/mixC (default 8)."),
      rerankTo: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Digests kept after cross-encoder rerank in mixC (default 3)."),
      minScore: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum cosine similarity for a retrieved digest (default 0.25)."),
      keywordMatch: z
        .boolean()
        .optional()
        .describe("Also match digest keywords whole-word against recent messages (default true)."),
      recencyBias: z
        .number()
        .min(0)
        .optional()
        .describe("Mild score boost toward recent digests in mixB/mixC (default 0 = off)."),
      summarizer: z
        .object({
          source: z
            .enum(["local", "hosted"])
            .optional()
            .describe("local GGUF (default if configured) | hosted Haiku fallback."),
          maxTokens: z.number().int().positive().optional(),
          temperature: z.number().min(0).max(2).optional(),
        })
        .optional()
        .describe("Which summarizer writes digests (local-first, hosted Haiku fallback)."),
    })
    .optional(),
});
export type GenerationParams = z.infer<typeof generationParamsSchema>;

/** Whether reasoning should be ON for these params: explicit "adaptive", a fixed budget, or an
 *  effort level (which implies thinking) — unless thinking is explicitly "off". Shared by both
 *  runners so the on/off decision is identical across modes. */
export function isThinkingOn(params: GenerationParams): boolean {
  if (params.thinking === "off") {
    return false;
  }
  return (
    params.thinking === "adaptive" ||
    params.thinkingBudgetTokens !== undefined ||
    params.effort !== undefined
  );
}
