# neo-tavern

Private, single-user RP frontend + a personal RAG/analytics layer over an RP
corpus. See `CLAUDE.md` for the full product brief and locked tech decisions.

This README covers **how to run it** and **the decisions made while scaffolding**
(Phase 1). The brief is the source of truth for product/tech direction; this is
the source of truth for the local toolchain.

## Requirements

- **Node ≥ 24** (`.nvmrc` pins 24) — see "Divergences" below.
- **pnpm 11** via corepack (`corepack enable`).

## Run

```bash
pnpm install
pnpm dev      # Vite (5173) + Hono API (8788) together; open http://localhost:5173
pnpm build    # vite build → dist/client
pnpm start    # NODE_ENV=production: Hono serves dist/client + /api on PORT (default 8788)
pnpm check    # the green-to-ship gate: biome + tsc + arch + vitest
pnpm arch     # validate the layer cake / dependency direction (also inside check)
pnpm arch:graph  # regenerate docs/dependency-graph.mmd
pnpm knip     # dead-code / unused-dependency scan (not part of `check`)
```

`pnpm check` is the contract: **green = ship.** It also runs on every commit via
the husky pre-commit hook.

The folder structure and dependency direction are a machine-enforced **layer
cake** — see [docs/architecture.md](docs/architecture.md). `pnpm arch`
(dependency-cruiser) fails the build if anything imports upward or sideways
across a layer boundary.

## Dev/prod topology

- **Dev:** Vite is the front door on `:5173` and proxies `/api` → Hono on `:8788`.
  Free HMR; one origin in the browser.
- **Prod:** Hono is the only process — it serves the built `dist/client` bundle
  *and* `/api`, with an `index.html` fallback so client-side routes survive a
  hard refresh.

## The quality gate (`biome.jsonc` + `tsconfig.json`)

These are configured maximally **now**, because the rules that are painful to
retrofit (import organization, type-only imports, naming, exhaustive deps) are
free to adopt on an empty codebase and brutal to add over thousands of lines.

Highlights of what's enabled beyond Biome's `recommended`:

- **Drizzle safety:** `noDrizzleDeleteWithoutWhere` / `noDrizzleUpdateWithoutWhere`.
- **Async (type-aware):** `noFloatingPromises`, `noMisusedPromises`,
  `useAwaitThenable`, `noBaseToString` — these only work because
  `linter.domains.project` enables Biome's project analysis.
- **Imports/types:** `useImportType`/`useExportType` (+ tsc `verbatimModuleSyntax`),
  `useNodejsImportProtocol`, `noBarrelFile`, `noReExportAll`, `noImportCycles`.
- **Discipline:** `noNonNullAssertion`, `noDefaultExport`, `noEnum`, `noNamespace`,
  `noTsIgnore`, `noConsole` (allows `info/warn/error`), `useNamingConvention`,
  `useFilenamingConvention`, `noProcessGlobal`.
- **TS strict flags:** everything, incl. `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`.

**Deliberately skipped** (with reasons, in `biome.jsonc`): `useExplicitReturnType`
(fights tRPC/TanStack inference), `useImportExtensions` (we use bundler
resolution), `noNamespaceImport` (Drizzle uses `import * as schema`),
`noProcessEnv`/`noMagicNumbers` (too noisy / low retrofit cost),
`useConsistentTypeDefinitions` (`z.infer` must be a `type`).

**Scoped overrides** (each documented inline): config files may default-export;
`src/client/routes/**` defers naming/export rules to TanStack; `src/client/**`
forbids Node builtins; `src/server/env.ts` keeps CONSTANT_CASE env keys.

Env access is centralized in `src/server/env.ts` (Zod-validated). Nothing else
reads `process.env`, which sidesteps the `noPropertyAccessFromIndexSignature` ↔
`useLiteralKeys` conflict cleanly.

## Divergences from the brief (raised, not silently substituted)

1. **Node 24, not 22.** This machine runs 24; you chose to target it.
2. **`biome.jsonc`, not `biome.json`.** Biome only allows comments in `.jsonc`,
   and the config is heavily commented on purpose.
3. **Vite proxies to Hono in dev** (brief said the inverse). The inverse needs
   fragile HMR-WebSocket proxying; this is the standard pattern and matches the
   reference project (Marinara). Same prod outcome.
4. **`routeTree.gen.ts` is committed** (not gitignored), so `pnpm check` and the
   pre-commit hook work from a clean clone with no codegen step. Biome/knip
   ignore it; tsc checks it.
5. **`tsx` runs the server in prod** (no separate `tsc` emit step) — lean choice;
   revisit if we want a compiled `dist/server`.

## Chat providers & auth

Two providers are wired (adapters in `src/server/providers/`); chat endpoints
that consume them come next.

- **Claude (sdk-mode / YGWYG) — `claude-sdk.ts`.** Uses the Claude Agent SDK,
  which spawns the official Claude Code runtime and authenticates with the
  host's **`claude login` (Max subscription)** — **no API key, no token
  extraction.** Verified: a probe ran with `apiKeySource: "none"` and succeeded.
  > ⚠️ Never extract the OAuth token from the Claude keychain to hit the API
  > directly — that route gets accounts **banned** (learned the hard way in
  > `st-claude-proxy`). Going through the official runtime is the safe path.

  Token discipline is borrowed from `st-claude-proxy`: no built-in tools, no MCP
  servers, no user settings/plugins, and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=true`
  (the string `"true"`, not `"1"`) — see `buildClaudeSdkEnv` in `env.ts`.
- **OpenRouter (raw-mode / non-Claude) — `openrouter.ts`.** The `openai` client
  pointed at OpenRouter; needs `OPENROUTER_API_KEY`.

Verify both at any time: **`pnpm verify:claude`** (runs one tiny Claude query on
the sub + checks OpenRouter reachability).

The model toggle catalog lives in `src/shared/models.ts` (latest Claude per
tier; default **Opus 4.7**), exposed via the tRPC `models` query.

## Deferred to later phases

Docker/compose, shadcn/ui, Playwright, Drizzle + libSQL schema, chat endpoints
that drive the providers, embeddings — all still ahead. The Claude + OpenRouter
provider adapters and the model catalog exist and are verified; chat itself is
the next step.

Deferred **dependencies** (what to add, when, and the exact command) live in
[docs/dependencies.md](docs/dependencies.md) — `package.json` can't hold comments,
so that's the parking lot. Domain reference repos (SillyTavern, Astra, Marinara)
clone into a gitignored `references/` — see [references/README.md](references/README.md).
