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
