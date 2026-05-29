import { isoToMs } from "../../../shared/time";
import { getLog } from "../../observability/logger";
import { getHostOpenRouterClient } from "./client";

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
    const res = (await getHostOpenRouterClient().credits.getCredits()) as unknown as {
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
    const res = (await getHostOpenRouterClient().generations.getGeneration({ id })) as unknown as {
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

/** A usage-analytics row, normalized: OpenRouter reports `date` as a "YYYY-MM-DD" UTC day string;
 *  we add the canonical `dateMs` (epoch-ms at UTC midnight) so the client never re-parses a string,
 *  consistent with every other timestamp in the app (shared/time.ts). The `date` label is kept for
 *  a chart axis. */
export interface OpenRouterActivityItem {
  date: string;
  dateMs: number | null;
  model: string;
  providerName: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  requests: number;
  usageUsd: number;
}

// The @openrouter/sdk normalizes the wire to camelCase; we read leniently (every field optional).
interface RawActivityRow {
  date?: string;
  model?: string;
  providerName?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  requests?: number;
  usage?: number;
}

/** Recent usage analytics, grouped by day/model (last ~30 UTC days), normalized (date → dateMs).
 *  NOTE: OpenRouter restricts this to MANAGEMENT (provisioning) keys — a normal inference key
 *  gets 401 "Only management keys can fetch activity". So this throws for most keys; that's an
 *  account-tier limitation, not a bug (logged at warn). credits/providers/catalog work on any key. */
export async function getOpenRouterActivity(): Promise<OpenRouterActivityItem[]> {
  try {
    const res = (await getHostOpenRouterClient().analytics.getUserActivity()) as unknown as {
      data?: RawActivityRow[];
    };
    const rows = (res.data ?? []).map((r) => ({
      date: r.date ?? "",
      dateMs: r.date !== undefined ? isoToMs(r.date) : null, // "YYYY-MM-DD" → UTC-midnight epoch-ms
      model: r.model ?? "",
      providerName: r.providerName ?? "",
      promptTokens: r.promptTokens ?? 0,
      completionTokens: r.completionTokens ?? 0,
      reasoningTokens: r.reasoningTokens ?? 0,
      requests: r.requests ?? 0,
      usageUsd: r.usage ?? 0,
    }));
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
    const res = (await getHostOpenRouterClient().providers.list()) as unknown as {
      data?: unknown[];
    };
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
    const res = (await getHostOpenRouterClient().endpoints.list({ author, slug })) as unknown as {
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
