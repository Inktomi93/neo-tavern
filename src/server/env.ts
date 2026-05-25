import process from "node:process";
import { z } from "zod";

// The ONLY place that touches process.env. Everything else imports `env` and
// reads known, typed keys (env.PORT) — which is dot access on a real property,
// so it satisfies both tsc's noPropertyAccessFromIndexSignature and Biome's
// useLiteralKeys at once. Passing process.env wholesale to .parse() never
// property-accesses the index signature, so neither rule fires here either.
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8788),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // OpenRouter (raw-mode + non-Claude models). Optional until raw mode lands.
  // sdk-mode (Claude) needs NO key here — it authenticates via the host's
  // `claude login` Max subscription; see buildClaudeSdkEnv below.
  OPENROUTER_API_KEY: z.string().min(1).optional(),

  // Observability (see src/server/observability + docs/observability.md).
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Gates the /api/_debug/* introspection API. UNSET = the API is disabled (404).
  // Set it (any value) to enable; requests must present it. Keep unset in prod
  // images unless you actually want the debug surface reachable.
  DEBUG_TOKEN: z.string().min(1).optional(),

  // Database — the libSQL file URL (dev: a local file; prod: the mounted volume).
  DATABASE_URL: z.string().min(1).default("file:./neo-tavern.db"),

  // Auth/tenancy (see CLAUDE.md). Identity = X-Authentik-Username, trusted ONLY when
  // caddy forwards it with a matching X-Neo-Proxy secret; otherwise (direct LAN/IP
  // access) we fall back to the owner. UNSET secret = header never trusted = always
  // the default user, which is correct for local dev (no caddy in front).
  DEFAULT_USER_HANDLE: z.string().min(1).default("owner"), // set to your authentik username so both access paths map to one user
  NEO_PROXY_SECRET: z.string().min(1).optional(),
});

export const env = envSchema.parse(process.env);

/**
 * Environment for the Claude Agent SDK subprocess. sdk-mode authenticates with
 * the host's `claude login` (Max subscription) through the official runtime —
 * verified: the probe ran with `apiKeySource=none` and still succeeded. We
 * never set or extract a token (keychain extraction → direct API is what gets
 * accounts banned; learned from st-claude-proxy). Spread process.env so the
 * subprocess keeps PATH/HOME (and thus ~/.claude credentials); drop any
 * ANTHROPIC_API_KEY (it would override the subscription); and keep CLAUDE.md
 * out of every request — must be the string "true", not "1" (st-claude-proxy
 * gotcha: Claude Code's isEnvTruthy() ignores "1").
 */
export function buildClaudeSdkEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "true",
  };
}
