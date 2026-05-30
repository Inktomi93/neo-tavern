# Package Modernization & Best Practices (2026)

This document tracks modern best practices and implementation details for the packages used in this project, ensuring we fully utilize their 2026 capabilities.

## tRPC (`@trpc/server`, `@trpc/client`, `@trpc/react-query`)

### Backend (`@trpc/server`) - ✅ Fully Utilized
Our backend implementation strictly follows 2026 standards:
- **Modular Routers:** `appRouter` correctly merges sub-routers by domain.
- **Layer Cake Separation:** Procedures are thin wrappers; domain logic is injected via `Context` services.
- **Strict Validation:** Using `zod` for robust runtime validation at the RPC boundary.
- **Error Middleware:** `domainErrorMiddleware` catches custom domain errors and maps them to standard `TRPCError` codes.

### Frontend (`@trpc/client`, `@trpc/react-query`) - 🚧 To Be Implemented
The frontend React application is currently a scaffold. When building out the client, ensure the following 2026 best practices are used:

1. **Request Batching (`httpBatchLink`)**
   When configuring the `trpcClient`, use `httpBatchLink` rather than the standard `httpLink`. This automatically combines concurrent procedure calls into a single HTTP request, minimizing network overhead.
   ```ts
   links: [
     httpBatchLink({
       url: '/api/trpc',
     }),
   ],
   ```

2. **Render-as-you-Fetch (TanStack Router Integration)**
   Since the project uses `@tanstack/react-router`, utilize tRPC's `queryClient.ensureQueryData` inside route `loader` functions. This prefetches data *before* the component transitions or renders, avoiding loading spinner waterfalls.

3. **Query Client & Provider Setup**
   Ensure the React root is wrapped with both `<trpc.Provider>` and `<QueryClientProvider>`. The `QueryClient` should be instantiated securely.

## Drizzle ORM (`drizzle-orm`, `drizzle-kit`) - ✅ Fully Utilized

Drizzle ORM is our SQL-first database abstraction. The 2026 state-of-the-art focuses entirely on stripping away abstraction costs to map query execution tightly to the underlying database driver.

Our backend is heavily optimized and currently executing all 2026 Drizzle best practices:
- **Prepared Statements (The Gold Standard):** Instead of Drizzle compiling SQL queries on every invocation, we use Drizzle's `.prepare()` feature cached in memory (e.g., `const maxSeqCache = new WeakMap<Db, any>()`). This allows the driver to reuse the pre-compiled binary query plans, heavily accelerating high-throughput endpoints.
- **Relational Builder Optimizations:** In the few places we use Drizzle's relational query builder (`db.query.*.findMany`), we explicitly define `columns: { id: true }` on relationships (like `variants`). This avoids the hidden `SELECT *` payload bloat that typically plagues ORMs.
- **Domain-Driven Schemas:** Our `src/db/schema.ts` explicitly exports modularized schemas (`schema/assets`, `schema/characters`, etc.). This keeps TypeScript inference fast and prevents the monolithic schema file anti-pattern.
- **Explicit Casing over Inference:** We explicitly use `snake_case` in column definitions instead of relying on Drizzle's runtime casing engine, which guarantees deterministic table structures without runtime translation overhead.

## Observability (`pino`) - ✅ Fully Utilized

Pino remains the performance benchmark for Node.js logging. The standard 2026 practice dictates moving away from slow string serialization to fast, structured JSON logging.

Our implementation (`src/server/observability/logger.ts`) is fully modern:
- **Asynchronous & In-Process Ring Buffer:** Instead of relying on slow file writes, logs are piped into a custom in-process memory ring buffer (`LineRing`), allowing instantaneous `/api/_debug` retrieval without tailing files.
- **`AsyncLocalStorage` Context Injection:** Rather than passing `logger` instances down manually through every function, we utilize Node's `AsyncLocalStorage` to inject request IDs (`logger.child({ requestId })`). Any call to `getLog()` automatically inherits the current context context.
- **Redaction:** `pino.redact` is configured at the root to automatically strip `authorization` tokens, ensuring sensitive data never hits the logs.

## Validation (`zod`) - ✅ Fully Utilized

In 2026, TypeScript types alone are not enough for the boundaries of an application. We utilize Zod natively integrated with tRPC (`.input(z.object(...))`) to guarantee that the data coming in perfectly matches our strict TS types before executing any domain logic. This is implemented universally across our router.

## AI SDKs (`@openrouter/sdk`, `@anthropic-ai/claude-agent-sdk`) - ✅ Fully Utilized

Our AI abstraction strictly adheres to the 2026 guidelines for unified API gateways and agentic design:
- **Singleton Client Management:** The OpenRouter client (`src/server/providers/openrouter/client.ts`) is initialized as a lazy singleton, preventing TCP connection exhaustion.
- **Environment Isolation:** Keys are dynamically verified from `env` before initialization, and we decouple the AI provider completely from the UI layer to allow swapping between Claude models, Llama, or DeepSeek without refactoring application code.

## Frontend State Management (`zustand`, `@tanstack/react-query`) - 🚧 To Be Implemented

The 2026 standard strictly separates "Client State" from "Server State". Mixing these is the #1 cause of React technical debt.
- **Server State (TanStack Query via tRPC):** Treat this as the singular source of truth for API data. Do not duplicate API data into Zustand or `useState`. Let Query handle caching, invalidation, and background syncs.
- **Client State (Zustand):** Use for global UI state only (e.g., active tabs, theme toggles, multi-step form progress). Keep Zustand stores **feature-scoped**. Instead of one massive global store, export multiple small stores to prevent cascading re-renders.
- **Local State (`useState`):** Continue to use local state for truly localized UI components (e.g., is a specific dropdown open).

## Frontend Routing (`@tanstack/react-router`) - 🚧 To Be Implemented

TanStack Router is preferred over classic alternatives because of its end-to-end type safety.
- **Type Safety First:** Do not cast `params` or `search` parameters. Let the router infer them safely.
- **Route Guards (`beforeLoad`):** Handle authentication or missing setup states inside the `beforeLoad` step. Throwing a `redirect` here executes *before* the component mounts, entirely eliminating the "flash of unauthorized content" problem.
- **Render-As-You-Fetch:** Preload tRPC queries in `loader` functions to ensure data and components load simultaneously.

## Styling (`tailwindcss v4`) - 🚧 To Be Implemented

Tailwind v4 is a total architectural rewrite that shifts configuration from JavaScript into CSS.
- **No `tailwind.config.js`:** All configuration is now done using standard CSS. Define your design tokens directly via the `@theme` directive inside `src/client/styles/globals.css`.
- **CSS Variables:** The `@theme` directive converts your tokens into standard CSS custom properties. You can now mix and match Tailwind utility classes with standard CSS easily.
- **Vite Plugin Only:** The old PostCSS chain is dead. Ensure you use the `@tailwindcss/vite` plugin and simply use `@import "tailwindcss";` in your main stylesheet.

## Developer Tooling & Architecture - ✅ Fully Utilized

The underlying dev infrastructure of this project is exceptional and follows the strictest 2026 engineering standards:
- **Biome:** Replacing ESLint/Prettier with Biome is the 2026 standard for speed. The `biome.jsonc` file is expertly tuned, specifically the `noBarrelFile` constraints, `noConsole` rules (forcing Pino), and targeted overrides for external AI APIs that require `snake_case`.
- **Dependency Cruiser:** The custom `.dependency-cruiser.cjs` enforcing a strict unidirectional "layer cake" (Shared → DB → Infra → Domain → tRPC) prevents the spaghetti code that normally plagues monolithic applications.
- **Vite & Plugins:** The `vite.config.ts` correctly sequences the `@tanstack/router-plugin` *before* the React plugin (which is a critical requirement) and seamlessly integrates the new Tailwind v4 Vite plugin.
