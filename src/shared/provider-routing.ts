import { z } from "zod";

// OpenRouter "provider routing" preferences — the request's `provider` object (order/fallbacks/
// sort/only/ignore/…). OpenRouter owns the wire schema and evolves it, so this is a LENIENT model:
// the known knobs are typed, and `.passthrough()` keeps any field we haven't modelled yet rather
// than dropping it. It replaces the bare `Record<string, unknown>` that flowed from chats.metadata
// → routing → the openrouter runner. Snake_case fields are OpenRouter's wire names (the import/**
// + providers biome override permits them).
export const openRouterProviderRoutingSchema = z
  .object({
    /** Ordered provider preference, e.g. ["Anthropic"] — what we pin so cache_control is honored. */
    order: z.array(z.string()),
    allow_fallbacks: z.boolean(),
    require_parameters: z.boolean(),
    data_collection: z.enum(["allow", "deny"]),
    /** Restrict to only these providers. */
    only: z.array(z.string()),
    /** Exclude these providers. */
    ignore: z.array(z.string()),
    quantizations: z.array(z.string()),
    sort: z.enum(["price", "throughput", "latency"]),
    max_price: z.record(z.string(), z.unknown()),
  })
  .partial()
  .passthrough();

export type OpenRouterProviderRouting = z.infer<typeof openRouterProviderRoutingSchema>;

/** Parse an unknown value (e.g. a chats.metadata field) into provider-routing prefs, leniently.
 *  Returns undefined for a non-object or a value that fails the (very permissive) schema. */
export function parseProviderRouting(value: unknown): OpenRouterProviderRouting | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const result = openRouterProviderRoutingSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
