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
pnpm arch:graph  # regenerate docs/architecture/dependency-graph.mmd
pnpm knip     # dead-code / unused-dependency scan (not part of `check`)
```

`pnpm check` is the contract: **green = ship.** It also runs on every commit via
the husky pre-commit hook.

## Corpus import + embedding (the RAG product)

```bash
# 1. Import a staged SillyTavern profile → DB rows (idempotent; re-run-safe)
pnpm import:st [dir]            # default dir: corpus-staging/default-user

# 2. Embed the imported corpus for semantic search (BGE-M3 → libSQL vectors)
pnpm embed:corpus              # CPU (slow on long text; fine for a small corpus)
pnpm embed:corpus:gpu          # GPU via in-process onnxruntime-node CUDA (~24× faster)
pnpm cuda:setup                # one-time: vendor CUDA-12 + cuDNN-9 into tools/cuda/.venv (uv)

# 3. Ranking quality (Phase 4.6.3): CSLS hubness + two-stage cross-encoder rerank
pnpm csls                      # precompute hub_score on the vector tables (CSLS, per type) — re-run on corpus change
pnpm corpus:backfill-source-text   # fill source_text on character_embeddings (rows embedded before the reranker; no re-embed)
pnpm rerank:probe              # validate the bge-reranker-v2-m3 cross-encoder (CSLS vs reranked, side by side)
pnpm discover:probe [--rerank] # validate `discover` ("who have I done X with") — characters + matching snippets
```

- **GPU is self-contained:** `embed:corpus:gpu` auto-bootstraps a project-local uv venv
  (`tools/cuda/`, gitignored) with the CUDA-12 runtime — no system CUDA install. Model
  weights cache to repo-local `.models/` (gitignored). Both are pinned via env
  (`EMBED_DEVICE`, `EMBED_DTYPE`, `MODEL_CACHE_DIR`). See `docs/subsystems/corpus-import.md`.
- Staging the corpus (root-owned ST docker volume): `docker cp sillytavern:/home/node/app/
  data/<profile> corpus-staging/<profile>` (gitignored; the `tests/fixtures/` subset is committed).

The folder structure and dependency direction are a machine-enforced **layer
cake** — see [docs/architecture/architecture.md](docs/architecture/architecture.md). `pnpm arch`
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

Two runners (adapters in `src/server/providers/`) cover four provider-mode pairings
(`chats.api` × `chats.source`), selected per turn by `resolveTurnRouting`. Both return the same
provider-agnostic `ChatTurnResult` and log model/cost/latency:

- **agent-sdk runner — `claude-sdk.ts`** — Claude via the Agent SDK. `source: max-pro-sub` =
  the free Max sub; `source: openrouter` = paid Claude through OpenRouter's Anthropic skin
  (same pipeline, credentials firewalled).
- **openrouter runner — `openrouter.ts`** — `@openrouter/sdk`. `api: chat-completions`
  (`chat.send`, broad catalog, 5m `cache_control` on Anthropic) and `api: responses`
  (`beta.responses`, OpenAI-style).

- **Claude auth (the agent-sdk runner) — `claude-sdk.ts`.** Uses the Claude Agent SDK,
  which spawns the official Claude Code runtime and authenticates with the
  host's **`claude login` (Max subscription)** — **no API key, no token
  extraction.** Verified: a probe ran with `apiKeySource: "none"` and succeeded.
  > ⚠️ Never extract the OAuth token from the Claude keychain to hit the API
  > directly — that route gets accounts **banned** (learned the hard way in
  > `st-claude-proxy`). Going through the official runtime is the safe path.

  Token discipline is borrowed from `st-claude-proxy`: no built-in tools, no MCP
  servers, no user settings/plugins, and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=true`
  (the string `"true"`, not `"1"`) — see `buildClaudeSdkEnv` in `env.ts`.
- **OpenRouter (raw-mode / non-Claude) — `openrouter.ts`.** The **official `@openrouter/sdk`**
  + the **Responses API** (`runRawTurn`), NOT the `openai` package (removed). Needs
  `OPENROUTER_API_KEY` — kept in a gitignored `.env` (loaded by `dotenv` with `override:true`,
  so a stale shell export can't win). The live `/models` catalog is public (no key).

Verify Claude at any time: **`pnpm verify:claude`** (one tiny Claude query on the sub +
OpenRouter reachability).

sdk-mode models live in `src/shared/models.ts` (latest Claude per tier; default **Opus 4.7**),
exposed via the tRPC `models` query. Raw-mode models are the **live OpenRouter catalog** via the
`rawModels` query.

**App auth** (who may use the app — distinct from the provider credentials above) is a pluggable
`AUTH_MODE` (`single-user` default · `forward-header` · `oidc`) behind authentik + caddy: the app only
*consumes* identity (never an IdP), with revocable BFF cookie sessions and per-user encrypted keys. It's
**built + verified live**. Design → [docs/auth/auth-and-credentials-plan.md](docs/auth/auth-and-credentials-plan.md);
deploy recipe → [docs/auth/auth-deploy.md](docs/auth/auth-deploy.md); verification → [docs/auth/auth-verify.md](docs/auth/auth-verify.md).

## Status

Not narrated here (it rots). Current state = the **git log** + the **code** (`src/db/schema.ts` +
migrations are the truth) + the **deferred backlog in `docs/planning/build-plan.md`**. Short version: rails +
the corpus RAG product + the chat *backend* (prompt assembly, the 4 provider modes, swipes/edits/fork)
are built and green; the chat *frontend* is the main thing left.

Deferred **dependencies** (what to add, when, and the exact command) live in
[docs/architecture/dependencies.md](docs/architecture/dependencies.md) — `package.json` can't hold comments,
so that's the parking lot. Domain reference repos (SillyTavern, Astra, Marinara)
clone into a gitignored `references/` — see [references/README.md](references/README.md).
