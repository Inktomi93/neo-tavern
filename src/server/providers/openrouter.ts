import { createHash } from "node:crypto";
import { OpenRouter } from "@openrouter/sdk";
import { z } from "zod";
import { env } from "../env";
import { getLog } from "../observability/logger";
import {
  type ChatTurnResult,
  type ChatTurnUsage,
  ClaudeTurnError,
  type TurnErrorKind,
} from "./claude-sdk";

// Raw-mode + non-Claude chats route through OpenRouter's OFFICIAL SDK (@openrouter/sdk) +
// the Responses API (beta.responses.send) — validated live against /home/inktomi/discovery/
// scaffold. The client is lazy so the server boots without a key; the key is only required
// the moment a raw turn actually calls out. (We deliberately do NOT use the openai package —
// the official SDK gives typed errors, routing metadata, image-gen, and the Responses API.)
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

let client: OpenRouter | null = null;

export function isOpenRouterConfigured(): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

export function getOpenRouterClient(): OpenRouter {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set; raw-mode / non-Claude chats are unavailable.");
  }
  if (!client) {
    client = new OpenRouter({ apiKey });
  }
  return client;
}

// ── Dynamic model catalog ────────────────────────────────────────────────────
// OpenRouter exposes a LIVE public catalog (~hundreds of models, changes often) at
// GET /models — no auth. We fetch + normalize + cache it rather than hardcoding a
// list: the model picker shows whatever OpenRouter offers right now.

/** Normalized view of one OpenRouter model (the fields a picker actually needs). */
export interface RawModel {
  id: string;
  name: string;
  /** Context window in tokens, when reported. */
  contextLength: number | null;
  /** USD per token (OpenRouter reports as strings); null when not priced/free. */
  promptPrice: number | null;
  completionPrice: number | null;
  /** e.g. ["text", "image"] — for multimodal filtering. */
  inputModalities: string[];
}

// Lenient — OpenRouter adds fields over time; z.object strips unknowns (we only pin what we read).
const openRouterModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  context_length: z.number().nullable().optional(),
  pricing: z
    .object({ prompt: z.string().optional(), completion: z.string().optional() })
    .optional(),
  architecture: z.object({ input_modalities: z.array(z.string()).optional() }).optional(),
});
const catalogSchema = z.object({ data: z.array(openRouterModelSchema) });

const CATALOG_TTL_MS = 60 * 60 * 1000; // 1h — the catalog changes slowly
let catalogCache: { at: number; models: RawModel[] } | null = null;

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Fetch + normalize + cache OpenRouter's live model catalog (public endpoint — no key). */
export async function listOpenRouterModels(force = false): Promise<RawModel[]> {
  if (!force && catalogCache !== null && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.models;
  }
  const res = await fetch(`${OPENROUTER_BASE_URL}/models`);
  if (!res.ok) {
    throw new Error(`OpenRouter /models returned ${res.status}`);
  }
  const parsed = catalogSchema.parse(await res.json());
  const models = parsed.data.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    contextLength: m.context_length ?? null,
    promptPrice: toNumberOrNull(m.pricing?.prompt),
    completionPrice: toNumberOrNull(m.pricing?.completion),
    inputModalities: m.architecture?.input_modalities ?? [],
  }));
  catalogCache = { at: Date.now(), models };
  return models;
}

// ── Raw turn (Responses API) ─────────────────────────────────────────────────
// The provider-agnostic mirror of the sdk-mode runChatTurn: takes the assembled system
// prompt + the full canon history, calls beta.responses.send, returns the SAME ChatTurnResult
// and throws the SAME ClaudeTurnError kinds. (The "Claude" name is a holdover — it's the shared
// provider-agnostic boundary; rename to TurnError is a pending cleanup.)

export interface RawTurnParams {
  /** OpenRouter "provider/model" id. */
  model: string;
  /** Assembled system prompt; static is the cache-stable prefix, dynamic the per-turn suffix. */
  systemPrompt: { static: string; dynamic: string };
  /** Full conversation from canon, oldest→newest (the last entry is the new user message). */
  history: { role: "user" | "assistant"; content: string }[];
  /** Generation params, flowing from the preset config. */
  params?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    reasoningEffort?: "low" | "medium" | "high";
  };
  /** OpenRouter provider-routing preferences (order/allowFallbacks/sort/only/ignore/…) → the
   *  Responses request's `provider` field. Lenient pass-through (OpenRouter owns the schema);
   *  undefined = default routing. Sourced per-chat (chats.metadata) by resolveTurnRouting. */
  providerRouting?: Record<string, unknown> | undefined;
}

// The slice of OpenResponsesResult we read (validated live; the SDK's full type is a big union).
interface ResponsesView {
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokensDetails?: { cachedTokens?: number };
    cost?: number;
  };
}

function buildInput(history: RawTurnParams["history"]): Array<{ role: string; content: string }> {
  const items = history
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
  // Responses input can't start with an assistant turn (e.g. a seeded greeting) — pad with a user stub.
  if (items[0]?.role === "assistant") {
    items.unshift({ role: "user", content: "…" });
  }
  return items;
}

// Map @openrouter/sdk errors → our provider-agnostic kinds. All response errors extend
// OpenRouterError (numeric `statusCode`); transport errors (connection/timeout/abort) carry a name.
function mapOpenRouterError(error: unknown, model: string): ClaudeTurnError {
  const status =
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : undefined;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  let kind: TurnErrorKind;
  let retryable: boolean;
  if (status === 401 || status === 403) {
    kind = "auth_failed";
    retryable = false;
  } else if (status === 402) {
    kind = "billing";
    retryable = false;
  } else if (status === 404) {
    kind = "model_unavailable";
    retryable = false;
  } else if (status === 429) {
    kind = "rate_limit";
    retryable = true;
  } else if (status === 400 || status === 413 || status === 422) {
    kind = "invalid";
    retryable = false;
  } else if (status !== undefined && status >= 500) {
    kind = "server";
    retryable = true;
  } else if (/timeout|connection|network|overload/i.test(`${name} ${message}`)) {
    kind = "server";
    retryable = true;
  } else if (/abort/i.test(name)) {
    kind = "aborted";
    retryable = false;
  } else {
    kind = "unknown";
    retryable = false;
  }
  return new ClaudeTurnError({
    kind,
    retryable,
    message: `openrouter (${model}): ${message}`,
    cause: error,
  });
}

function extractReply(view: ResponsesView): string {
  return (view.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/**
 * One raw-mode turn over OpenRouter's Responses API. Provider-agnostic out the top: returns a
 * {@link ChatTurnResult}, throws a {@link ClaudeTurnError} (mapped from the SDK's typed errors).
 * Injected into `domain/chat` as a seam so it's testable with a fake (no network in `pnpm check`).
 */
export async function runRawTurn(params: RawTurnParams): Promise<ChatTurnResult> {
  const startedAt = Date.now();
  const instructions = [params.systemPrompt.static, params.systemPrompt.dynamic]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
  const cfg = params.params ?? {};

  // promptCacheKey lets OpenRouter cache the system prefix across turns (the raw-mode cache lever).
  const promptCacheKey =
    instructions.length > 0
      ? createHash("sha1").update(`${params.model} ${instructions}`).digest("hex").slice(0, 16)
      : undefined;

  const responsesRequest = {
    model: params.model,
    input: buildInput(params.history),
    ...(instructions.length > 0 ? { instructions } : {}),
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.topP !== undefined ? { topP: cfg.topP } : {}),
    ...(cfg.frequencyPenalty !== undefined ? { frequencyPenalty: cfg.frequencyPenalty } : {}),
    ...(cfg.presencePenalty !== undefined ? { presencePenalty: cfg.presencePenalty } : {}),
    ...(cfg.maxOutputTokens !== undefined ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
    ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort, summary: "auto" } } : {}),
    ...(params.providerRouting !== undefined ? { provider: params.providerRouting } : {}),
    ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
  };

  let view: ResponsesView;
  try {
    // The SDK's request type is a large generated union; we build the proven shape and narrow
    // the boundary with one contained cast (the runtime is validated by the SDK's own zod parse).
    const result = await getOpenRouterClient().beta.responses.send({
      responsesRequest,
    } as Parameters<OpenRouter["beta"]["responses"]["send"]>[0]);
    view = result as unknown as ResponsesView;
  } catch (error) {
    const mapped = mapOpenRouterError(error, params.model);
    getLog().error(
      { model: params.model, kind: mapped.kind, retryable: mapped.retryable, err: mapped.message },
      "openrouter: raw turn failed",
    );
    throw mapped;
  }

  const u = view.usage;
  const usage: ChatTurnUsage = {
    model: params.model,
    tokensIn: u?.inputTokens ?? 0,
    tokensOut: u?.outputTokens ?? 0,
    cacheReadTokens: u?.inputTokensDetails?.cachedTokens ?? 0,
    cacheWriteTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    costUsd: u?.cost ?? 0,
  };

  getLog().info(
    {
      model: params.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - startedAt,
    },
    "openrouter: raw turn complete",
  );

  return {
    reply: extractReply(view),
    sessionId: "", // raw mode has no SDK session — history is rebuilt from canon each turn
    stopReason: null,
    terminalReason: null,
    ttftMs: null,
    apiErrorStatus: null,
    numTurns: 1,
    usage,
    events: [],
    rateLimit: null,
  };
}
