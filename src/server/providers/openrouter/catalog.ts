import { getLog } from "../../observability/logger";
import { getHostOpenRouterClient } from "./client";

// ── Dynamic model catalog (via the SDK) ───────────────────────────────────────
// GET /models through sdk.models.list() — the live OpenRouter catalog (~hundreds of models). We
// normalize to the fields a picker + the caching/cost logic actually read, and cache it (1h) rather
// than hardcode.

/** Normalized view of one OpenRouter model (the fields a picker + caching/cost logic need). */
export interface RawModel {
  id: string;
  name: string;
  /** Context window in tokens, when reported. */
  contextLength: number | null;
  /** USD per token (OpenRouter reports as strings); null when not priced/free. */
  promptPrice: number | null;
  completionPrice: number | null;
  /** Cache pricing — present (non-null) iff the model has explicit prompt caching with cache pricing. */
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  /** e.g. ["text", "image"] — for multimodal filtering. */
  inputModalities: string[];
  /** Generation params the model/provider accepts (e.g. "tools", "reasoning", "temperature"). */
  supportedParameters: string[];
}

const CATALOG_TTL_MS = 60 * 60 * 1000; // 1h — the catalog changes slowly
let catalogCache: { at: number; models: RawModel[] } | null = null;

function toNumberOrNull(value: string | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Fetch + normalize + cache OpenRouter's live model catalog via the SDK. */
export async function listOpenRouterModels(force = false): Promise<RawModel[]> {
  if (!force && catalogCache !== null && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.models;
  }
  let data: ModelCatalogView["data"];
  try {
    const res = (await getHostOpenRouterClient().models.list()) as unknown as ModelCatalogView;
    data = res.data ?? [];
  } catch (error) {
    getLog().error(
      { err: error instanceof Error ? error.message : String(error) },
      "openrouter: model catalog fetch failed",
    );
    throw error;
  }
  const models: RawModel[] = data.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    contextLength: m.contextLength ?? null,
    promptPrice: toNumberOrNull(m.pricing?.prompt),
    completionPrice: toNumberOrNull(m.pricing?.completion),
    cacheReadPrice: toNumberOrNull(m.pricing?.inputCacheRead),
    cacheWritePrice: toNumberOrNull(m.pricing?.inputCacheWrite),
    inputModalities: m.architecture?.inputModalities ?? [],
    supportedParameters: (m.supportedParameters ?? []).map((p) => String(p)),
  }));
  catalogCache = { at: Date.now(), models };
  getLog().info({ count: models.length }, "openrouter: model catalog refreshed");
  return models;
}

// The slice of the SDK's ModelsListResponse we read (its full type is a large generated shape).
interface ModelCatalogView {
  data?: Array<{
    id: string;
    name?: string;
    contextLength?: number | null;
    pricing?: {
      prompt?: string;
      completion?: string;
      inputCacheRead?: string;
      inputCacheWrite?: string;
    };
    architecture?: { inputModalities?: string[] };
    supportedParameters?: unknown[];
  }>;
}
