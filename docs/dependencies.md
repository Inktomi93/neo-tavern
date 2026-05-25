# Dependency parking lot

`package.json` can't carry comments, so this is where **deferred dependencies**
live — with what they're for, when to add them, and the exact command. Nothing
gets installed until the feature that needs it lands; that keeps `knip` clean and
avoids dead deps. Uncomment + run when it's time.

> Locked stack reminder (from `CLAUDE.md`): React + Vite + TanStack + Tailwind +
> shadcn + Zustand + RHF. **Never** add: Next.js/RSC, MUI/AntD, Redux,
> styled-components, CSS Modules, ESLint, Prettier.

## Installed now

Runtime: `hono`, `@hono/node-server`, `@trpc/{server,client,react-query}`,
`@tanstack/{react-query,react-router}`, `react`, `react-dom`, `zod`,
`@anthropic-ai/claude-agent-sdk`, `openai`.
Tooling: biome, typescript, vite, tsx, vitest, dependency-cruiser, knip, husky,
tailwindcss (v4), concurrently.

## Client — with `shadcn init` (first real UI: `features/chat`)

```bash
# The cn() trio + icons + animations + toasts that shadcn/ui generates against.
# shadcn also copies @radix-ui/react-* in per-component as you add them.
# pnpm add clsx tailwind-merge class-variance-authority lucide-react tw-animate-css sonner
```

- **clsx + tailwind-merge + class-variance-authority** — the `cn()` class-merge helper + variant API every shadcn component uses.
- **lucide-react** — icon set (shadcn default).
- **tw-animate-css** — Tailwind v4 animation utilities (the v4 replacement for `tailwindcss-animate`).
- **sonner** — toast notifications (shadcn standard).

## Client — state & forms

```bash
# pnpm add zustand                              # global + feature-local client state (brief-locked)
# pnpm add react-hook-form @hookform/resolvers  # forms (character/persona editors), validated with zod
```

## Client — per feature (Phase 2+)

```bash
# chat: render RP messages as SANITIZED markdown (React-idiomatic; AstraProjecta used vanilla markdown-it)
# pnpm add react-markdown remark-gfm rehype-sanitize

# long lists: virtualize the 400+ character corpus + long chats (TanStack family — essential for the RAG product)
# pnpm add @tanstack/react-virtual

# editors: prompts / character cards / world entries
# pnpm add @uiw/react-codemirror @codemirror/state @codemirror/view @codemirror/lang-markdown
```

## Client — analytics (Phase 6 dashboards)

```bash
# pnpm add recharts   # token burn, character co-occurrence, theme clustering charts
```

## Server — persistence (Phase 2)

```bash
# pnpm add drizzle-orm @libsql/client
# pnpm add -D drizzle-kit
# pnpm add nanoid          # id generation for rows
# sqlite-vec is loaded as a libSQL/SQLite extension at runtime — not an npm dep.
```

## Server — embeddings / RAG (Phase 3)

```bash
# pnpm add @huggingface/transformers   # BGE-M3 (default) or Qwen3-Embedding local embeddings
```

## Server — structured logging + observability ✅ INSTALLED

`pino` (+ `pino-pretty` dev) are in. The logging + `curl`-able `/api/_debug/*`
layer is built in `src/server/observability/` — see **`docs/observability.md`**.
(Not deferred; here for the record.)

## Testing (the kit — see `tests/AGENTS.md` for the doctrine)

```bash
# coverage (report, not a gate — `vitest run --coverage`)
# pnpm add -D @vitest/coverage-v8

# component tests — also split vitest into node + happy-dom projects (see tests/AGENTS.md)
# pnpm add -D happy-dom @testing-library/react @testing-library/jest-dom @testing-library/user-event

# mock OUTBOUND HTTP only (OpenRouter, client fetch) — never the DB
# pnpm add -D msw

# E2E: ONE happy-path per critical flow, sparingly, no screenshot diffs. Own runner.
# pnpm add -D @playwright/test
```

In-memory DB tests need **no new dep** — libSQL `:memory:` + drizzle + drizzle-kit
(already in the server/persistence set). When test files + these deps land, add
`tests` to knip's project globs so the test-only deps aren't flagged as unused.

## Considered & deliberately skipped (so we don't re-litigate)

- **@tabler/icons** — lucide-react covers it.
- **vaul** — only if we lean hard into mobile bottom-sheets.
- **@headless-tree** — only when the world-info / lorebook tree UI lands.
- **markdown-it** — AstraProjecta's pick; we use `react-markdown` (React-native, easier sanitization).
