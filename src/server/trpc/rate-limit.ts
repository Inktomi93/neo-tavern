import { TRPCError } from "@trpc/server";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { securityEvent } from "../observability/logger";

// Per-user rate limiting (breadth-buildout A.2.2). In-memory (RateLimiterMemory — ST's choice, no
// Redis; the deploy is one process). Keyed on the resolved IDENTITY (handle), NOT IP — IP is useless
// behind Caddy and authed requests always have an identity. Two tiers:
//   • general: every authed MUTATION (cheap backstop against a runaway client)
//   • ai-turn: additionally the GPU/$-spending turns (send/swipe/start) — the real point
// Pure helper (no `t` import) so trpc.ts wraps it in a middleware without an import cycle.

// Tuned for a single-operator RP app: generous enough to never bite normal use, low enough to cap a
// loop. ai-turn at 30/min ≈ one every 2s — well above human RP cadence, below a runaway script.
const generalLimiter = new RateLimiterMemory({ points: 120, duration: 60 });
const aiTurnLimiter = new RateLimiterMemory({ points: 30, duration: 60 });

// The GPU/$-spending turn verbs (chat.start covers the generateOpening path).
const AI_TURN_PATHS: ReadonlySet<string> = new Set(["chat.send", "chat.swipe", "chat.start"]);

/** Consume from the general limiter (+ the ai-turn limiter for turn verbs); throw TOO_MANY_REQUESTS
 *  when either is exhausted. Called from the authed-mutation middleware. */
export async function enforceRateLimit(opts: { path: string; key: string }): Promise<void> {
  try {
    await generalLimiter.consume(opts.key, 1);
    if (AI_TURN_PATHS.has(opts.path)) {
      await aiTurnLimiter.consume(`ai:${opts.key}`, 1);
    }
  } catch (rejection) {
    // RateLimiterMemory rejects with a RateLimiterRes (not an Error) when the bucket is empty; it does
    // not throw real errors. Treat any rejection here as "limited".
    securityEvent("rate_limit", { key: opts.key, path: opts.path });
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded — slow down a moment.",
      cause: rejection instanceof Error ? rejection : undefined,
    });
  }
}
