// ── Provider-aware caching ───────────────────────────────────────────────────
// OpenRouter's `cache_control` is ANTHROPIC-ONLY (the spec: "Currently supported for Anthropic
// Claude models"); non-Anthropic models cache AUTOMATICALLY with no field, so we send it iff the
// routed model is Anthropic. The directive is the DEFAULT 5m TTL (no `ttl` field) — deliberately,
// per the SillyTavern recipe: 1h cache writes cost ~2× the 5m price, AND `ttl:"1h"` would require
// the `anthropic-beta: extended-cache-ttl` header (which @openrouter/sdk does not send → no cache
// at all). 5m covers back-to-back RP turns at a fraction of the cost. (History-depth breakpoints →
// a later refinement, #48; ST also caches at a configurable message depth.)
export const ANTHROPIC_CACHE = { type: "ephemeral" } as const;

/** True when the model id routes to Anthropic (the only family that honors explicit cache_control). */
export function isAnthropicModel(model: string): boolean {
  return /^anthropic\//i.test(model) || /(^|\/)claude[-/]/i.test(model);
}

// Anthropic prompt caching only takes effect when OpenRouter routes to Anthropic-DIRECT — measured:
// an unpinned Anthropic model can land on an endpoint that silently ignores cache_control (0 cache),
// while the same request pinned to Anthropic caches (write→read). So for Anthropic models we prefer
// the Anthropic provider so our cache_control is honored. Order-only (fallbacks stay ON), so this
// doesn't sacrifice reliability. A caller-supplied providerRouting wins (they're in control).
export function effectiveProviderRouting(
  model: string,
  userRouting: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (userRouting !== undefined) {
    return userRouting;
  }
  return isAnthropicModel(model) ? { order: ["Anthropic"] } : undefined;
}
