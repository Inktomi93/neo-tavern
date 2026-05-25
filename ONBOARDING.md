# Onboarding — neo-tavern

New here (human or agent)? This is the 5-minute map. It **points** at the authoritative docs
rather than repeating them, so it can't drift.

## What this is

A private, **single-user** RP frontend + **personal RAG/analytics layer** over a SillyTavern
corpus (~310 characters, hundreds of chats), self-hosted behind authentik + caddy. **The corpus
tool is the product; chat is incidental.** Full mission + the non-obvious vision (YGWYG, the mode
escape valve, World Info as explicit attachment) live in **`CLAUDE.md`** — read that first; it's
the brief and it's auto-loaded for the AI agent every session.

## Prerequisites

- **Node 24** + **pnpm 11** (`corepack enable`).
- **sdk-mode chat auth:** the host must be logged in via `claude login` (Max subscription) — the
  Agent SDK uses that session. **No API key**, and **never extract the OAuth token** (ban risk).
- **GPU embedding (optional):** `uv` (for the project-local CUDA-12 runtime) + an NVIDIA GPU.
  CPU works without it; GPU is ~24× faster for the corpus index.

## Set up & run

```bash
pnpm install
pnpm dev        # Vite :5173 + Hono API :8788 together → http://localhost:5173
pnpm check      # green-to-ship gate (biome + tsc + arch + vitest); also runs on pre-commit
```
Full script list + dev/prod topology + the corpus import/embed commands: **`README.md`**.

## How it's built (so you don't fight it)

- **Machine-enforced layer cake** — `db → shared`; infra (auth/providers/embeddings) above that;
  `domain/<feature>` orchestrates infra+db; drivers (`trpc`/`jobs`) reach db **only through
  domain**. `pnpm arch` fails the build on any upward/sideways import. One dir per feature; the
  only sanctioned barrels are feature `index.ts` front doors. **Read `docs/architecture.md`
  before touching imports.**
- **Stack:** Hono · Drizzle + libSQL (native `F32_BLOB` vectors) · tRPC · React 19 + Vite +
  TanStack · Tailwind v4 · shadcn (in-repo). Biome + dependency-cruiser + vitest. **No CI**
  (homelab) — `pnpm check` is the contract. **Commit to `main`.**
- **Corpus pipeline:** `pnpm import:st` (ST PNG/JSONL → DB rows, idempotent) → `pnpm
  embed:corpus:gpu` (BGE-M3 → libSQL vectors; self-contained GPU via `tools/cuda` uv venv,
  weights cached to `.models/`). The parsers + RAG ranking are **lifted from our prior projects
  card-curator & st-bridge** (cloned in `references/`) — see **`docs/corpus-import.md`**, the
  answer key; don't re-derive.

## Where to go deeper

| You want… | Read |
|---|---|
| Mission, locked decisions, current phase, hard-won facts | **`CLAUDE.md`** (the agent brief) |
| Build order + status | `docs/build-plan.md` |
| The layer cake + folder map | `docs/architecture.md` |
| DB schema | `docs/data-model.md` |
| ST import + RAG (the answer key) | `docs/corpus-import.md` |
| Logging + the `/api/_debug` API | `docs/observability.md` |
| Agent SDK + the `pnpm sdk:play` playground | `docs/sdk-notes.md` |
| The reference clones (read, don't copy) | `references/README.md` |

**Current state** is the per-phase ✅ markers in `CLAUDE.md` + the live task queue (the AI agent's
`TaskList`) + recent git log — not duplicated here, so it never goes stale.
