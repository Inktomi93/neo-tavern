# tests/AGENTS.md — testing doctrine

Read this before writing a test. Goal: tests that catch real regressions and
**survive refactors** — not tests that restate the code or break when you rename a
field. Grounded in current Vitest / Testing Library / tRPC / Drizzle practice.

## First principle: test behavior, not implementation

A test asserts what a unit **does** (observable behavior through its public API),
never **how** it does it. If a behavior-preserving refactor breaks your test, the
test was wrong, not the code.

## "No shit tests" — what NOT to write

Coding agents statistically **over-mock and write tautologies** (there's literature
on it). You are an agent. Be deliberate:

- **No tautologies.** Don't assert a mock returned what you told it to. Don't
  restate the implementation. A `getById` test that mocks the db and checks the
  query was built is not a test — it's the code, retyped.
- **Don't over-mock.** If the unit-under-test is buried in mocks, you're testing
  the mocks. Mock only true boundaries (below). Never mock internal helpers or your
  own domain functions.
- **Don't test the framework.** Zod validates, Drizzle queries, React renders —
  that's their job, already tested. Test YOUR logic.
- **No shared mutable state between tests.** No test depends on another's order or
  leftover data. Fresh fixtures every test.
- **No snapshot-as-assertion.** Snapshots only for large, stable, deliberately
  reviewed output — never a lazy "assert everything."
- **Public API only.** Don't reach into private internals.
- **One behavior per test.** A pile of trivial side-effect assertions that never
  checks the core behavior is noise.

## Mock ONLY the boundaries

- **Mock:** model providers (Claude SDK, OpenRouter — *never* hit a real model in a
  test), outbound HTTP (MSW), time (`vi.useFakeTimers`), randomness / id generation
  (seed or stub nanoid).
- **Do NOT mock:** the database (use a **real in-memory libSQL** — fast *and* real),
  domain logic, internal modules, shared/zod.

The DB being real-but-in-memory is the whole trick: integration tests are honest
and still milliseconds.

## What to test, by layer (the cake → targets)

| Layer | Test? | How |
| --- | --- | --- |
| `shared/` (zod, helpers, models) | ✅ | pure unit — schema accepts/rejects, helper computes |
| `db/` (schema) | ❌ directly | exercised via domain integration (testing the schema def is a tautology) |
| `domain/` (logic) | ✅✅ **primary** | pure unit for logic; integration w/ in-memory libSQL for repos; mock the provider boundary |
| `providers/` (adapters) | ⚠️ minimal | only pure request/response mapping; real auth/calls verified by `pnpm verify:claude`, not unit tests |
| `trpc/` (transport) | ✅ integration | `createCaller(testCtx)` + in-memory DB + mocked providers; assert behavior, input validation, auth |
| `client/features/` (UI) | ✅ component | RTL + happy-dom; render → user-event → assert by role; mock tRPC at the boundary |
| `routes/` (thin) | ❌ mostly | `tsc` + `pnpm arch` already prove the wiring |
| critical flows | ✅ E2E (sparingly) | ONE Playwright happy-path per flow; **never** screenshot diffs |

Most tests live in `domain/`. That's *why* transport/routes are thin — the testable
logic is concentrated where tests pay off.

## Where tests live + naming

- **Co-located** `*.test.ts(x)` next to the source (`domain/chat/turn.test.ts`,
  `features/chat/MessageList.test.tsx`) for **single-unit** unit + component tests.
  They're exempt from `not-to-dev-dep` and `not-to-test`, so they may import
  vitest/RTL/fixtures.
- **`tests/`** (outside `src/`, so the layer-cake rules don't scrutinize deliberate
  cross-layer imports) for:
  - `tests/integration/` — tRPC caller + in-memory DB spanning layers.
  - `tests/e2e/` — Playwright (its **own** runner; excluded from vitest).
  - `tests/support/` — factories, the in-memory-db helper, MSW handlers, fixtures.
- **Always use explicit imports** (`import { test, expect, vi } from "vitest"`) — no
  globals — to satisfy `verbatimModuleSyntax` + our no-implicit-globals rules.

## The kit (deferred in `docs/dependencies.md`; install when first tests land)

- `@vitest/coverage-v8` — coverage.
- `happy-dom` — client test environment.
- `@testing-library/react` + `@testing-library/jest-dom` + `@testing-library/user-event`.
- `msw` — mock outbound HTTP (OpenRouter) + client fetch at the boundary.
- `@playwright/test` — E2E, sparingly.
- In-memory DB needs **no new dep** — libSQL `:memory:` + drizzle + drizzle-kit.

## Planned `vitest.config.ts` (apply when component tests arrive)

Split into projects so server runs in node and client in happy-dom:

```ts
test: {
  projects: [
    { test: { name: "server", environment: "node",
        include: ["src/server/**/*.test.ts", "src/shared/**/*.test.ts", "tests/integration/**/*.test.ts"] } },
    { test: { name: "client", environment: "happy-dom",
        include: ["src/client/**/*.test.{ts,tsx}"],
        setupFiles: ["tests/support/setup-dom.ts"] } }, // @testing-library/jest-dom matchers
  ],
  exclude: ["**/node_modules/**", "**/dist/**", "references/**", "tests/e2e/**"], // e2e = playwright's runner
  restoreMocks: true, // fresh mock state every test (isolation)
  coverage: { provider: "v8", include: ["src/**"],
    exclude: ["**/*.test.*", "**/routeTree.gen.ts", "src/**/index.ts"] },
}
```

## Patterns (copy these)

- **AAA** — Arrange (fixtures) → blank line → Act (call the unit) → blank line →
  Assert (observable result).
- **In-memory DB fixture** (`tests/support/db.ts`): `createClient({ url: ":memory:" })`
  → `drizzle(client, { schema })` → apply migrations → seed. Fresh per test via
  `test.extend`, not a shared singleton.
- **tRPC** — `const caller = appRouter.createCaller(testCtx({ db, username }))`;
  `await caller.chats.send(input)`; assert the result **and** the resulting DB state.
- **RTL** — query by role first (`getByRole("button", { name: /send/i })`),
  `userEvent` over `fireEvent`, assert what the user sees. `getByTestId` is a last
  resort, not a default.
- **Determinism** — fake timers for anything time-based; seed/stub id generation;
  never depend on the wall clock or real randomness.
- **Fixtures via `test.extend`** for reusable setup (db, a seeded character, a
  caller) — not copy-pasted `beforeEach`.

## Coverage philosophy

Coverage shows what you **forgot** to test, not whether the tests are good. Target
`domain/`. Run it as a report (`pnpm test:cov`), **don't gate `pnpm check` on it**
until there's a real baseline — then a floor for domain (~80%), never a chase to
100%. 100% coverage of tautologies is worthless; 70% of real behavior is gold.
