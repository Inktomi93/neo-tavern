import { createHash } from "node:crypto";
import { OpenRouter } from "@openrouter/sdk";
import { env } from "../env";
import { getLog } from "../observability/logger";
import { type ChatTurnResult, type ChatTurnUsage, TurnError, type TurnErrorKind } from "./turn";

// The OpenRouter-runner side of the provider architecture (the @openrouter/sdk path, distinct from
// the Agent-SDK runner used for Claude). Two endpoints:
//   • Chat Completions (sdk.chat.send)        → runChatCompletionTurn — the broad catalog
//   • Responses        (sdk.beta.responses)   → runRawTurn            — OpenAI-style models
// Plus the live model catalog + account info (credits / per-generation cost), all via the SDK.
// The client is lazy so the server boots without a key; the key is only required when a turn or a
// catalog/info call actually goes out.

let client: OpenRouter | null = null;

export function isOpenRouterConfigured(): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

export function getOpenRouterClient(): OpenRouter {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set; the OpenRouter runner is unavailable.");
  }
  if (!client) {
    client = new OpenRouter({ apiKey });
  }
  return client;
}

// ── Provider-aware caching ───────────────────────────────────────────────────
// OpenRouter's `cache_control` is ANTHROPIC-ONLY (the spec: "Currently supported for Anthropic
// Claude models"); non-Anthropic models cache AUTOMATICALLY with no field, so we send it iff the
// routed model is Anthropic. The directive is the DEFAULT 5m TTL (no `ttl` field) — deliberately,
// per the SillyTavern recipe: 1h cache writes cost ~2× the 5m price, AND `ttl:"1h"` would require
// the `anthropic-beta: extended-cache-ttl` header (which @openrouter/sdk does not send → no cache
// at all). 5m covers back-to-back RP turns at a fraction of the cost. (History-depth breakpoints →
// a later refinement, #48; ST also caches at a configurable message depth.)
const ANTHROPIC_CACHE = { type: "ephemeral" } as const;

/** True when the model id routes to Anthropic (the only family that honors explicit cache_control). */
export function isAnthropicModel(model: string): boolean {
  return /^anthropic\//i.test(model) || /(^|\/)claude[-/]/i.test(model);
}

// Anthropic prompt caching only takes effect when OpenRouter routes to Anthropic-DIRECT — measured:
// an unpinned Anthropic model can land on an endpoint that silently ignores cache_control (0 cache),
// while the same request pinned to Anthropic caches (write→read). So for Anthropic models we prefer
// the Anthropic provider so our cache_control is honored. Order-only (fallbacks stay ON), so this
// doesn't sacrifice reliability. A caller-supplied providerRouting wins (they're in control).
function effectiveProviderRouting(
  model: string,
  userRouting: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (userRouting !== undefined) {
    return userRouting;
  }
  return isAnthropicModel(model) ? { order: ["Anthropic"] } : undefined;
}

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
    const res = (await getOpenRouterClient().models.list()) as unknown as ModelCatalogView;
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

// ── Account info (the "fully featured" extras) ─────────────────────────────────
// Thin reads over the rest of the @openrouter/sdk surface (credits / analytics / generations /
// providers / endpoints), normalized to the slices we display. Every call logs through the central
// logger (debug on success, error on failure) so account state is observable via /api/_debug.

export interface OpenRouterCredits {
  total: number;
  used: number;
}

/** Current credit balance: total purchased + total used (USD). */
export async function getOpenRouterCredits(): Promise<OpenRouterCredits> {
  try {
    const res = (await getOpenRouterClient().credits.getCredits()) as unknown as {
      data?: { totalCredits?: number; totalUsage?: number };
      totalCredits?: number;
      totalUsage?: number;
    };
    const d = res.data ?? res;
    const out = { total: d.totalCredits ?? 0, used: d.totalUsage ?? 0 };
    getLog().debug({ total: out.total, used: out.used }, "openrouter: credits");
    return out;
  } catch (error) {
    getLog().error(
      { err: error instanceof Error ? error.message : String(error) },
      "openrouter: credits lookup failed",
    );
    throw error;
  }
}

/** Authoritative per-generation cost/usage (settles a few seconds after the turn returns). */
export async function getOpenRouterGenerationCost(
  id: string,
): Promise<{ totalCost: number; tokensPrompt: number; tokensCompletion: number } | null> {
  try {
    const res = (await getOpenRouterClient().generations.getGeneration({ id })) as unknown as {
      data?: { totalCost?: number; tokensPrompt?: number; tokensCompletion?: number };
    };
    const d = res.data;
    if (!d) {
      return null;
    }
    getLog().debug({ id, totalCost: d.totalCost }, "openrouter: generation cost");
    return {
      totalCost: d.totalCost ?? 0,
      tokensPrompt: d.tokensPrompt ?? 0,
      tokensCompletion: d.tokensCompletion ?? 0,
    };
  } catch (error) {
    getLog().warn(
      { id, err: error instanceof Error ? error.message : String(error) },
      "openrouter: generation cost lookup failed",
    );
    return null;
  }
}

/** Recent usage analytics, grouped by day/model (last ~30 UTC days). Returns the raw rows.
 *  NOTE: OpenRouter restricts this to MANAGEMENT (provisioning) keys — a normal inference key
 *  gets 401 "Only management keys can fetch activity". So this throws for most keys; that's an
 *  account-tier limitation, not a bug (logged at warn). credits/providers/catalog work on any key. */
export async function getOpenRouterActivity(): Promise<unknown[]> {
  try {
    const res = (await getOpenRouterClient().analytics.getUserActivity()) as unknown as {
      data?: unknown[];
    };
    const rows = res.data ?? [];
    getLog().debug({ rows: rows.length }, "openrouter: activity");
    return rows;
  } catch (error) {
    getLog().warn(
      { err: error instanceof Error ? error.message : String(error) },
      "openrouter: activity lookup failed (needs a management key?)",
    );
    throw error;
  }
}

/** The provider directory (names, policies). Returns the raw rows. */
export async function listOpenRouterProviders(): Promise<unknown[]> {
  try {
    const res = (await getOpenRouterClient().providers.list()) as unknown as { data?: unknown[] };
    const rows = res.data ?? [];
    getLog().debug({ rows: rows.length }, "openrouter: providers");
    return rows;
  } catch (error) {
    getLog().error(
      { err: error instanceof Error ? error.message : String(error) },
      "openrouter: providers lookup failed",
    );
    throw error;
  }
}

/** The per-model endpoint list (which providers serve a model, at what price/latency). `model` is
 *  an OpenRouter id ("author/slug"); the SDK call takes the split halves. */
export async function listOpenRouterEndpoints(model: string): Promise<unknown> {
  const slash = model.indexOf("/");
  if (slash < 0) {
    throw new Error(`openrouter endpoints: model id "${model}" is not "author/slug"`);
  }
  const author = model.slice(0, slash);
  const slug = model.slice(slash + 1);
  try {
    const res = (await getOpenRouterClient().endpoints.list({ author, slug })) as unknown as {
      data?: unknown;
    };
    getLog().debug({ model }, "openrouter: endpoints");
    return res.data ?? null;
  } catch (error) {
    getLog().error(
      { model, err: error instanceof Error ? error.message : String(error) },
      "openrouter: endpoints lookup failed",
    );
    throw error;
  }
}

// ── Shared turn params + error mapping ─────────────────────────────────────────

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
  /** OpenRouter provider-routing preferences (order/allowFallbacks/sort/only/ignore/…). Lenient
   *  pass-through (OpenRouter owns the schema); undefined = default routing. From chats.metadata. */
  providerRouting?: Record<string, unknown> | undefined;
}

// Map @openrouter/sdk errors → our provider-agnostic kinds. Response errors carry a numeric
// statusCode; transport errors (connection/timeout/abort) carry a name.
function mapOpenRouterError(error: unknown, model: string, endpoint: string): TurnError {
  const status =
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : undefined;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  // Exhaustive over the status codes the OpenRouter spec documents (400/401/402/403/404/408/413/
  // 422/429/500/502/503) → our provider-agnostic TurnErrorKind; transport-level failures fall back
  // to name/message heuristics; anything else is `unknown`.
  let kind: TurnErrorKind;
  let retryable: boolean;
  if (status === 401 || status === 403) {
    // 401 = bad/missing key; 403 = insufficient perms OR a guardrail block. Non-retryable either way.
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
  } else if (status === 408 || (status !== undefined && status >= 500)) {
    // 408 Request Timeout + 5xx (500 internal / 502 bad gateway / 503 unavailable) — all transient.
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
  return new TurnError({
    kind,
    retryable,
    message: `openrouter ${endpoint} (${model}): ${message}`,
    ...(status !== undefined ? { apiErrorStatus: status } : {}),
    cause: error,
  });
}

/** Join the assembled static + dynamic halves into one system string (the simple, cross-provider
 *  shape). Finer-grained static/history cache breakpoints are a later refinement (#48). */
function joinSystemPrompt(sp: { static: string; dynamic: string }): string {
  return [sp.static, sp.dynamic]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

// ── Chat Completions runner (sdk.chat.send) ────────────────────────────────────

// The slice of ChatResult we read (its full type is a large generated union).
interface ChatResultView {
  id?: string;
  choices?: Array<{
    message?: { content?: unknown };
    finishReason?: string | null;
  }>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    cost?: number | null;
    promptTokensDetails?: { cachedTokens?: number; cacheWriteTokens?: number } | null;
  };
}

function extractChatReply(view: ChatResultView): string {
  const content = view.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type?: string; text?: string } =>
          part !== null && typeof part === "object",
      )
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

// The system message for a chat-completions turn, with provider-aware caching. For Anthropic we
// emit PER-BLOCK cache_control on the STATIC text block — this pins the cache breakpoint at the
// stable system prompt so it's written once and reused every turn. (The top-level cacheControl
// directive instead pins the breakpoint at the LAST block — the volatile newest user message — so
// no reusable cache forms; measured live, cacheWrite stayed 0.) The dynamic half goes in a second
// (uncached) block after it, mirroring sdk-mode's boundary. Non-Anthropic models cache automatically
// → a plain joined string (sending Anthropic cache_control to them is wrong).
type ChatSystemMessage =
  | { role: "system"; content: string }
  | {
      role: "system";
      content: Array<{
        type: "text";
        text: string;
        cacheControl?: typeof ANTHROPIC_CACHE;
      }>;
    };

function buildChatSystemMessage(
  staticPart: string,
  dynamicPart: string,
  anthropic: boolean,
): ChatSystemMessage | null {
  if (staticPart.length === 0 && dynamicPart.length === 0) {
    return null;
  }
  if (anthropic && staticPart.length > 0) {
    return {
      role: "system",
      content: [
        { type: "text", text: staticPart, cacheControl: ANTHROPIC_CACHE },
        ...(dynamicPart.length > 0 ? [{ type: "text" as const, text: dynamicPart }] : []),
      ],
    };
  }
  return {
    role: "system",
    content: [staticPart, dynamicPart].filter((s) => s.length > 0).join("\n\n"),
  };
}

/**
 * One Chat Completions turn over OpenRouter (sdk.chat.send). Provider-agnostic out the top (returns
 * a {@link ChatTurnResult}, throws a {@link TurnError}), so domain/chat can inject it as a seam.
 * Caching is provider-aware: Anthropic models get a PER-BLOCK cache_control on the static system
 * block (pins the breakpoint at the stable prompt → reused across turns); everything else relies on
 * the provider's automatic caching. Cost + cached-token reads come back inline in usage.
 */
export async function runChatCompletionTurn(params: RawTurnParams): Promise<ChatTurnResult> {
  const startedAt = Date.now();
  const cfg = params.params ?? {};
  const anthropic = isAnthropicModel(params.model);

  const systemMessage = buildChatSystemMessage(
    params.systemPrompt.static.trim(),
    params.systemPrompt.dynamic.trim(),
    anthropic,
  );
  const messages = [
    ...(systemMessage ? [systemMessage] : []),
    ...params.history
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content })),
  ];
  const chatProvider = effectiveProviderRouting(params.model, params.providerRouting);

  const chatRequest = {
    model: params.model,
    messages,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.topP !== undefined ? { topP: cfg.topP } : {}),
    ...(cfg.maxOutputTokens !== undefined ? { maxCompletionTokens: cfg.maxOutputTokens } : {}),
    ...(cfg.frequencyPenalty !== undefined ? { frequencyPenalty: cfg.frequencyPenalty } : {}),
    ...(cfg.presencePenalty !== undefined ? { presencePenalty: cfg.presencePenalty } : {}),
    ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
    ...(chatProvider !== undefined ? { provider: chatProvider } : {}),
  };

  let view: ChatResultView;
  try {
    const result = await getOpenRouterClient().chat.send({
      chatRequest,
    } as Parameters<OpenRouter["chat"]["send"]>[0]);
    view = result as unknown as ChatResultView;
  } catch (error) {
    const mapped = mapOpenRouterError(error, params.model, "chat");
    getLog().error(
      {
        model: params.model,
        status: mapped.apiErrorStatus,
        kind: mapped.kind,
        retryable: mapped.retryable,
        err: mapped.message,
      },
      "openrouter: chat turn failed",
    );
    throw mapped;
  }

  const u = view.usage;
  const usage: ChatTurnUsage = {
    model: params.model,
    tokensIn: u?.promptTokens ?? 0,
    tokensOut: u?.completionTokens ?? 0,
    cacheReadTokens: u?.promptTokensDetails?.cachedTokens ?? 0,
    cacheWriteTokens: u?.promptTokensDetails?.cacheWriteTokens ?? 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    costUsd: u?.cost ?? 0,
  };

  getLog().info(
    {
      model: params.model,
      anthropicCaching: anthropic,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - startedAt,
    },
    "openrouter: chat turn complete",
  );

  return {
    reply: extractChatReply(view),
    sessionId: "", // the openrouter runner has no SDK session — history is rebuilt from canon
    stopReason: view.choices?.[0]?.finishReason ?? null,
    terminalReason: null,
    ttftMs: null,
    apiErrorStatus: null,
    numTurns: 1,
    usage,
    events: [],
    rateLimit: null,
  };
}

// ── Responses runner (sdk.beta.responses.send) ─────────────────────────────────

// The slice of OpenResponsesResult we read.
interface ResponsesView {
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  outputText?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number | null;
    inputTokensDetails?: { cachedTokens?: number };
  };
}

function buildResponsesInput(
  history: RawTurnParams["history"],
): Array<{ role: string; content: string }> {
  const items = history
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
  // Responses input can't start with an assistant turn (e.g. a seeded greeting) — pad with a user stub.
  if (items[0]?.role === "assistant") {
    items.unshift({ role: "user", content: "…" });
  }
  return items;
}

function extractResponsesReply(view: ResponsesView): string {
  if (typeof view.outputText === "string" && view.outputText.length > 0) {
    return view.outputText.trim();
  }
  return (view.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/**
 * One Responses-API turn over OpenRouter (sdk.beta.responses.send) — the OpenAI-style endpoint.
 * Provider-aware caching: Anthropic models get the top-level cache_control directive; for the rest
 * (OpenAI et al.) we set a stable `promptCacheKey` derived from the system prompt so the provider's
 * automatic cache routes consistently across turns (the correct field, replacing the old sha1 hack).
 */
export async function runRawTurn(params: RawTurnParams): Promise<ChatTurnResult> {
  const startedAt = Date.now();
  const instructions = joinSystemPrompt(params.systemPrompt);
  const cfg = params.params ?? {};
  const anthropic = isAnthropicModel(params.model);

  // A stable per-system-prompt key lets OpenAI-style providers reuse their automatic cache across
  // turns. Anthropic uses the cache_control directive instead (promptCacheKey is a no-op there).
  const promptCacheKey =
    !anthropic && instructions.length > 0
      ? createHash("sha1").update(`${params.model} ${instructions}`).digest("hex").slice(0, 32)
      : undefined;
  const responsesProvider = effectiveProviderRouting(params.model, params.providerRouting);

  const responsesRequest = {
    model: params.model,
    input: buildResponsesInput(params.history),
    ...(instructions.length > 0 ? { instructions } : {}),
    ...(anthropic && instructions.length > 0 ? { cacheControl: ANTHROPIC_CACHE } : {}),
    ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.topP !== undefined ? { topP: cfg.topP } : {}),
    ...(cfg.frequencyPenalty !== undefined ? { frequencyPenalty: cfg.frequencyPenalty } : {}),
    ...(cfg.presencePenalty !== undefined ? { presencePenalty: cfg.presencePenalty } : {}),
    ...(cfg.maxOutputTokens !== undefined ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
    ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort, summary: "auto" } } : {}),
    ...(responsesProvider !== undefined ? { provider: responsesProvider } : {}),
  };

  let view: ResponsesView;
  try {
    const result = await getOpenRouterClient().beta.responses.send({
      responsesRequest,
    } as Parameters<OpenRouter["beta"]["responses"]["send"]>[0]);
    view = result as unknown as ResponsesView;
  } catch (error) {
    const mapped = mapOpenRouterError(error, params.model, "responses");
    getLog().error(
      {
        model: params.model,
        status: mapped.apiErrorStatus,
        kind: mapped.kind,
        retryable: mapped.retryable,
        err: mapped.message,
      },
      "openrouter: responses turn failed",
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
      anthropicCaching: anthropic,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - startedAt,
    },
    "openrouter: responses turn complete",
  );

  return {
    reply: extractResponsesReply(view),
    sessionId: "",
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
