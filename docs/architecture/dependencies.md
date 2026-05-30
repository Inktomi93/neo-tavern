# Dependencies

What's installed, what each thing replaces from the reference stacks (SillyTavern / AstraProjecta /
Marinara), and the small set still genuinely deferred. `package.json` can't carry comments, so the
*why* lives here.

> Locked stack reminder (from `CLAUDE.md`): React + Vite + TanStack + Tailwind + shadcn + Zustand +
> RHF. **Never** add: Next.js/RSC, MUI/AntD, Redux, styled-components, CSS Modules, ESLint, Prettier.

> **Heads-up — the frontend deps are installed AHEAD of the UI.** The React frontend is still
> scaffolding (`src/client/features/*` are mostly `.gitkeep`), so `pnpm knip` currently reports the
> client libraries below as **unused dependencies** (~25). That's expected until the chat/corpus UI
> consumes them — it is NOT the old "don't install before a consumer" discipline (that rule held while
> the parking lot was real; the client set has since been front-loaded). `knip` is not in `pnpm check`,
> so it doesn't gate commits; treat the unused-dep list as a frontend-build TODO, not a regression.

## Installed — server / runtime

- **`hono`, `@hono/node-server`** — the HTTP server + Node adapter.
- **`@trpc/{server,client,react-query}`, `@tanstack/react-query`** — typed RPC boundary + server-state cache.
- **`zod`** — runtime validation at every boundary (tRPC inputs, blob parsers, env).
- **`@anthropic-ai/claude-agent-sdk`** — the **agent-sdk runner** (modes 1+2).
- **`@openrouter/sdk`** — the **openrouter runner** (chat-completions + responses). The OFFICIAL SDK,
  **NOT** the `openai` package (removed) — typed errors, routing metadata, the live model catalog.
- **`@huggingface/transformers`** — in-process BGE-M3 embeddings + `bge-reranker-v2-m3` reranker (onnx, CUDA EP).
- **`@anush008/tokenizers`** — native Rust tokenizer for real BGE token counts (the transformers.js JS tokenizer is quadratic).
- **`node-llama-cpp`** — local GGUF summarizer (Qwen3) for digest generation (`docs/subsystems/chat-memory.md`); Haiku fallback over OpenRouter.
- **`drizzle-orm`, `@libsql/client`** — the ORM + libSQL driver. Vectors are native `F32_BLOB` + `libsql_vector_idx` (no sqlite-vec).
- **`nanoid`** — row id generation. **`luxon`** (+ `@types/luxon`) — the canonical epoch-ms-UTC time layer (`src/shared/time.ts`).
- **`dotenv`** — loads a gitignored `.env` with `override:true` (a local key beats a stale shell export; `src/server/env.ts`).
- **`atomically`** — durable atomic writes for the content-addressed asset store (`src/server/storage/cas.ts`); see `docs/subsystems/assets.md`.
- **`sharp`** — image processing (avatar/card handling). **`fflate`** — zip (un)packing for export/import.
- **Auth:** **`jose`** (JWT/JWKS — `forward-header` verifies `X-Authentik-Jwt`), **`openid-client`** v6 (the `oidc` AUTH_MODE).

> **`@openrouter/sdk` build note:** its postinstall is skipped (`pnpm-workspace.yaml`
> `allowBuilds: '@openrouter/sdk': false`) — the prebuilt ESM works without it (verified live). Don't "approve" the build.

## Installed — client / UI (front-loaded; knip-unused until the UI lands)

The shadcn base + the per-feature client libs. **What each replaces** in the reference stacks:

| Dep(s) | Role | Replaces (ST / Astra / Marinara) |
|---|---|---|
| `clsx` + `tailwind-merge` + `class-variance-authority` | the `cn()` class-merge + variant API every shadcn component uses (`src/client/lib/utils.ts`) | Astra/Marinara `clsx`+`tailwind-merge` |
| `radix-ui` + `@radix-ui/react-slot` | shadcn primitive substrate | Astra `@radix-ui/*` |
| `lucide-react` | icon set (shadcn default) | Astra/Marinara `lucide-react`; skip `@tabler/icons` |
| `tw-animate-css` | Tailwind v4 animation utilities | the v4 replacement for `tailwindcss-animate` / Marinara `framer-motion` |
| `sonner` | toast notifications (shadcn standard) | Marinara `sonner` |
| `zustand` | GLOBAL/feature-local client state only (server state stays in TanStack Query) | Marinara `zustand` (but feature-scoped stores, not one 80KB god-store) |
| `react-hook-form` + `@hookform/resolvers` | character/persona/preset editors, validated with the existing `zod` schemas | ST DOM-state forms |
| `react-markdown` + `remark-gfm` + `rehype-sanitize` (+ `rehype-raw`) | render RP messages as SANITIZED markdown (React-idiomatic) | ST `showdown`+`dompurify`; Astra vanilla `markdown-it` |
| `@tanstack/react-virtual` | virtualize the 400+ char corpus + long chats | ST jQuery list rendering |
| `@uiw/react-codemirror` + `@codemirror/{state,view,lang-markdown}` | prompt / character-card / world-entry editors | ST `chevrotain`; Astra `@codemirror/*` |
| `react-resizable-panels` | the resizable chat/sidebar split | Marinara panel logic |
| `recharts` | analytics dashboards (token burn, co-occurrence, theme charts; Phase 6) | — (neo-original) |

Tailwind v4 is configured via `@tailwindcss/vite` + `@theme` in `src/client/styles/globals.css` (no `tailwind.config.js`).

## Installed — tooling

- **Build/dev:** `vite`, `@vitejs/plugin-react`, `babel-plugin-react-compiler`, `@tailwindcss/vite`,
  `@tanstack/router-plugin` (must sequence BEFORE the React plugin), `tsx`, `concurrently`.
- **Quality gate (`pnpm check`):** `@biomejs/biome`, `typescript`, `dependency-cruiser`, `vitest`. Plus `husky` (pre-commit).
- **Not gating:** `knip` (dead-code/dep report), `jscpd` (copy-paste), `typescript-language-server`.
- **Testing kit:** `vitest` + `@vitest/{browser,browser-playwright,coverage-v8}`, `@testing-library/{react,jest-dom,user-event}`,
  `msw` (mock OUTBOUND http only — never the DB), `@playwright/test` + `playwright` (one happy-path E2E per flow).
- **GPU runtime:** CUDA-12 + cuDNN-9 are vendored project-locally with **uv** (`tools/cuda/`, `pnpm cuda:setup`) —
  NOT an npm/system dep. `onnxruntime-node` (native, pulled via `@huggingface/transformers`) gets `allowBuilds`.
  Model weights cache to repo-local `.models/` (`MODEL_CACHE_DIR`, gitignored).
- Dev logging: `pino-pretty` (the `dev:server` pretty stream; prod emits JSON). `@types/*` for node/react/luxon.

## Genuinely deferred (not yet added — add when the feature lands)

- **`@headless-tree`** — only when the world-info / lorebook tree UI lands.
- **`undici`** (explicit) + **`rate-limiter-flexible`** — Track A security (SSRF egress firewall + rate limiting); see `docs/planning/breadth-buildout.md`.
- **`croner`** — the scheduled-work seam when the first real maintenance task arrives (`docs/planning/maintenance-and-scheduling.md`).

## Considered & deliberately skipped (so we don't re-litigate)

- **`@tabler/icons`** — `lucide-react` covers it. · **`vaul`** — only if we lean hard into mobile bottom-sheets.
- **`markdown-it`** — AstraProjecta's pick; we use `react-markdown` (React-native, easier sanitization).
- **`framer-motion`** — `tw-animate-css` covers the v4 animation need.
- **Translation APIs** (`bing-translate-api`, `google-translate-api-x`) — out of scope (single-user RP, slop guard).
- **Git-backup libs** (`isomorphic-git`, `simple-git`) — out of scope; SQLite is canon, standard DB backup instead.
- **Client persistence** (`localforage`, `node-persist`) — stateless client; TanStack Query + the libSQL backend are the source of truth.
