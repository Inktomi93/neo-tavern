# Codebase conventions & recurring gotchas (the dance)

The specific traps an agent hits, re-derives, and fights `pnpm check` over — and the proven
way past each. `AGENTS.md` has the *principles*; this is the *concrete how*. **Read it before
writing, not after the linter yells.** (Rule of thumb: **fix the code, don't loosen the rule**;
the few sanctioned overrides below all exist for genuinely-external data and are documented in
`biome.jsonc`.)

## The #1 reflex: format what you touch BEFORE `pnpm check`

Biome **will** reformat (line-wrap at 100, sort imports/exports) and **fail** `check` over
pure formatting — this is the most-repeated dance. After writing/editing any file:
`pnpm exec biome check --write <files>` first, then `pnpm check`. Never hand-format to guess
Biome's wrapping. (Also re-format generated files: `pnpm exec biome check --write src/db/migrations/`
— drizzle's meta JSON needs a trailing newline.)

## Logging — `console` is banned in `src/server`

- **`src/server/**`:** use `getLog()` (`src/server/observability/logger.ts`); in tRPC procedures
  use `ctx.log`. **Never** `console.*`, **never** `import pino` directly — both are lint errors.
  Call `getLog()` **inside** the method (not cached at service creation) so it binds the
  request-scoped child logger. Levels: `info` for one-time notable events (model load), `debug`
  for per-op. Logs are metadata — never log RP bodies. Inspect via `/api/_debug/*`, not log files.
- **`scripts/**`:** `console` IS the output channel (CLI tools) — sanctioned (`biome.jsonc`
  override `noConsole: off`). The `embed-probe`/`import-st`/`sdk-playground` precedent.
- **`src/server/observability/**`:** the one place `pino` itself is allowed.

## The Biome ⇄ tsc conflict on external/dynamic data (we dance here most)

tsc's `noPropertyAccessFromIndexSignature` **requires bracket** access (`obj["k"]`) on a
`Record<string, unknown>` / index signature; Biome's `useLiteralKeys` **wants dot** (`obj.k`).
**Irreconcilable** for the same expression. Plus external **snake_case** fields (ST wire JSON,
transformers.js `session_options`, OS env vars) trip `useNamingConvention`. Two fixes:

1. **Known shape → a typed interface** (named optional props, no index signature). Dot access
   then satisfies BOTH rules. Preferred when you know the fields (e.g. `RawCard`/`RawMessage`
   in `domain/import/`).
2. **Genuinely dynamic / external snake_case → a scoped `biome.jsonc` override** disabling
   `useLiteralKeys` (+ `useNamingConvention` for snake_case) for that path, **with a comment
   why.** Precedents to copy: `src/server/env.ts` (OS env names), `src/server/domain/import/**`
   (ST wire fields), `src/server/embeddings/**` (transformers.js option keys).

## Strict-TS traps (tsconfig is maximal)

- **`noNonNullAssertion` — `!` is banned.** Use `?? fallback`, an early guard, or narrow with a
  check + local const. (Tests too — `(await q)[0]?.id ?? ""`.)
- **`noUncheckedIndexedAccess`** — `arr[i]` / `obj[k]` is `T | undefined`. `?? fallback` or guard.
- **`exactOptionalPropertyTypes`** — a zod `.optional()` field spread into a type needs
  `field: X | undefined`, NOT `field?: X` (the `?` form rejects an explicit `undefined`).
- **`verbatimModuleSyntax`** — `import type { … }` for type-only imports (Biome `useImportType`).
- **`noNestedTernary`** — convert `a ? x : b ? y : z` to `if` statements (e.g. the owner-knn filter).
- No `any`; no default exports outside config/route files; `noShadow`.

## Tooling quirks

- **`tsx -e '<code with top-level await>'` FAILS** ("Top-level await not supported with the cjs
  output format"). Write a temp `.ts` file and run `pnpm exec tsx file.ts` instead (then `rm`).
- **drizzle-kit can't emit `libsql_vector_idx`** — hand-add the ANN `CREATE INDEX` to the
  generated migration SQL (see `0001`). Migrations are **additive**: never regenerate `0000–N`;
  hand-read the generated SQL (the SQLite differ sometimes recreates more than intended — confirm
  it doesn't drop columns/indexes from earlier migrations).
- **`pnpm exec tsx`**, not bare `tsx` (not always on PATH).

## libSQL / native vectors

- Vectors are **native `F32_BLOB` + `libsql_vector_idx`** — NO sqlite-vec.
- A vector-indexed table **cannot UPSERT** (`onConflictDoUpdate` → `failed to insert shadow row`)
  and **cannot bulk `DELETE FROM`** (corrupts the shadow table → native `corrupted double-linked
  list` abort). So: **plain `INSERT`**; idempotency via a `unique(...)` index + the *caller*
  skipping known keys; **re-index = drop the DB file + re-import**, never `DELETE`.
- `foreign_keys = ON` is set per-connection in `db/client.ts`; only `ownerId → users.id` FKs
  exist today (internal links are plain `text` — hardening pending in migration 0005).

## Workflow

- **Commit directly to `main`** (homelab, no CI). `pnpm check` is the green-to-ship gate and runs
  on the husky pre-commit hook — it must pass before "done."
- **Don't install a dep before it has a consumer** (knip flags dead deps) — check `docs/dependencies.md`.
- Adding a top-level dir? Confirm biome/tsc/vitest/knip/dependency-cruiser still scope correctly.
- **`Edit` `old_string` must match exactly** — watch for unicode (em-dash `—`, `·`, `…`); copy
  from a fresh `Read`, don't retype.
