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
  generated migration SQL (see `0001`/`0016`). Migrations are **additive**: never regenerate `0000–N`;
  hand-read the generated SQL (the SQLite differ sometimes recreates more than intended — confirm
  it doesn't drop columns/indexes from earlier migrations).
- **The drizzle-kit snapshots are FROZEN at `0010`; `0011+` are HAND-WRITTEN** (no snapshot/journal
  regen). So `drizzle-kit generate` diffs against stale state (it still thinks `chats` has the
  retired `mode`/`provider` cols) AND it **prompts interactively** (no TTY in CI/web → it errors out).
  **Don't fight it — hand-write the migration**: copy the proven table-recreate shape from `0007`
  (SQLite can't `ALTER ADD CONSTRAINT`, so an FK on an existing column = `PRAGMA foreign_keys=OFF` →
  `__new_*` table → copy → drop → rename → recreate indexes → `ON`), use plain `ALTER TABLE ADD/DROP
  COLUMN` where possible (`0011`/`0016`), then add the `_journal.json` entry by hand. Validate by
  running the suite (`freshDb` applies every migration — a wrong column list fails the import tests).
- **`pnpm exec tsx`**, not bare `tsx` (not always on PATH).

## libSQL / native vectors  (VERIFIED — corrected after an over-cautious earlier claim)

- Vectors are **native `F32_BLOB` + `libsql_vector_idx`** — NO sqlite-vec. Image vectors are
  supported too (it's vector-agnostic): a separate `F32_BLOB(<imgDim>)` column/table + its own
  ANN index. CLIP (`Xenova/clip-vit-base-patch32`, 512-dim) embeds card PNGs in our stack —
  verified; deferred by choice (text-only), not a limitation.
- **Full CRUD works + the index auto-maintains** (Turso docs + empirically tested on a file DB):
  `INSERT`, `UPDATE` (vector), **`UPSERT`** (`onConflictDoUpdate`), and **targeted `DELETE WHERE …`**
  all succeed and keep `vector_top_k` consistent. (UPDATE is internally DELETE+INSERT.)
- **The ONE footgun:** `DELETE FROM <table>` that **empties** a vector-indexed table poisons the
  shadow index → the *next* `INSERT` fails `failed to insert shadow row`. **Recover with
  `REINDEX <index_name>`** (verified to fully repair it) — or use targeted deletes / DROP+recreate /
  a fresh DB. Don't bulk-`DELETE FROM`-then-insert without a `REINDEX` between.
- **Embed pass still uses plain `INSERT` + caller-skip (`existingKeys`)** — NOT because upsert is
  impossible (it isn't), but because *skipping already-embedded entities is the right resumable-pass
  behavior*. **Incremental re-embed** of a changed entity = **targeted `DELETE WHERE entity_id LIKE
  '<id>%'` + re-INSERT** (both proven safe) — same pattern as card-curator's ChromaDB delete-and-readd.
- Known quirk: `count(*)` can read 0 on a vector-indexed table in some bindings — verify counts via
  the rows, not blind `count(*)`.
- **`vector_top_k('idx', vec, N)` returns far FEWER than N for large N** (measured: asked 8225, got
  ~200). The ANN graph traversal has a bounded search budget — it is a *top-k* operator, not a scan.
  Fine for small k (the real top-10/40 are exact-ish); but DON'T over-fetch a huge pool expecting it
  back. To rank/visit "most of the corpus" (e.g. an exact re-rank), `SELECT … FROM embeddings` and
  compute, don't crank N. (It already bit CSLS hub-scoring: per-row `vector_top_k` gave the most
  POPULAR cards hub 0 — their ~200 nearest were their own chat segments, never 10 other cards — so
  `computeHubScores` does an exact in-process same-type top-K instead. Same trap awaits the
  reranker/discover over-fetch: cap the pool at a few hundred, or compute exactly.)
- **`db.transaction()` breaks on `:memory:`** (the test DB): drizzle's libSQL `transaction()`
  acquires a *fresh connection*, which for `:memory:` is a brand-new EMPTY database — so the
  writes vanish and the next `db` query throws `no such table`. A file DB is fine. For batch
  writes that must also run under in-memory tests (e.g. `domain/corpus/hubness` hub_score
  updates), use sequential auto-commit `db.update(...)` in a loop, NOT a transaction.
- `foreign_keys = ON` is set per-connection in `db/client.ts`; only `ownerId → users.id` FKs
  plus the internal FKs from migration 0007 (cascade policy in `docs/data-model.md`); polymorphic
  refs (`embeddings`/`taggables` entity columns) stay plain `text`.

## Time & dates — one canonical format: epoch-ms UTC

**Every timestamp we store or surface is an integer epoch-MILLISECONDS UTC instant.** No ISO
strings in columns, no local-tz, no epoch-seconds leaking past a boundary. The client renders it in
the viewer's timezone (`Intl.DateTimeFormat`) — store UTC, display local.

- **`src/shared/time.ts` is the ONLY place that parses/normalizes time** (Luxon-backed). Use its
  helpers; don't hand-roll:
  - `epochToMs(n)` — a number that may be seconds OR ms → ms (the ≥1e12 heuristic).
  - `secondsToMs(n)` — a DOCUMENTED-seconds field → ms (composes with `undefined`).
  - `isoToMs(s)` — ISO-8601 → ms; a naive (no-offset) string is read as **UTC**, deterministically.
  - `utcFormatToMs(s, fmt)` — an explicit Luxon format token, parsed as UTC.
- **Normalize at the boundary, never downstream.** Known provider/import units (all converted on
  the way in): Agent-SDK rate-limit **`resetsAt` is epoch SECONDS**; OpenRouter `created` is epoch
  seconds (we don't store it — receipt `Date.now()` instead); OpenRouter `activity.date` is
  `"YYYY-MM-DD"` (→ `dateMs`); ST imports are epoch s/ms · ISO · `@14h56m48s` · human — `parseStDate`
  parses **all as UTC**.
- **Banned:** `new Date(y, mo, d, …)` (LOCAL tz — the importer bug we fixed) and `Date.parse` on a
  naive ISO string (engine-dependent local-vs-UTC). Use `Date.UTC(...)` or the `shared/time.ts`
  parsers.
- **The one sanctioned ISO-string exception:** `domain/chat/seed.ts` emits ISO-UTC `timestamp`
  strings because the Agent SDK's session-FRAME format requires ISO — that's the SDK's shape, not
  our storage. Everything we own stays epoch-ms.
- **Library:** Luxon (server-side, for parsing) backs `shared/time.ts`. The client needs no date
  dep — `Intl` formats epoch-ms in the viewer's zone when the UI lands.

## Workflow

- **Commit directly to `main`** (homelab, no CI). `pnpm check` is the green-to-ship gate and runs
  on the husky pre-commit hook — it must pass before "done."
- **Don't install a dep before it has a consumer** (knip flags dead deps) — check `docs/dependencies.md`.
- Adding a top-level dir? Confirm biome/tsc/vitest/knip/dependency-cruiser still scope correctly.
- **`Edit` `old_string` must match exactly** — watch for unicode (em-dash `—`, `·`, `…`); copy
  from a fresh `Read`, don't retype.
