/**
 * dependency-cruiser — the machine-enforced "layer cake" + data direction.
 *
 * Layers, low → high (a layer may import anything BELOW it, never above/sideways):
 *
 *     src/shared      types & zod schemas — the foundation; imports nothing internal
 *     src/db          Drizzle schema + libSQL — persistence; imports shared only
 *     src/server/{providers,embeddings,auth,env}   infrastructure (external systems, config)
 *     src/server/{domain,services}                 business logic (future)
 *     src/server/trpc                              transport edge — calls DOWN into the above
 *     src/server/index.ts                          composition root / entry
 *     src/client      browser/presentation — imports shared, and server ONLY as types (tRPC)
 *
 * Run by `pnpm arch` (part of `pnpm check` and the pre-commit hook).
 * Visualize with `pnpm arch:graph`.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  extends: "dependency-cruiser/configs/recommended-strict",
  forbidden: [
    {
      name: "shared-is-foundation",
      comment:
        "src/shared is the base of the cake (types + zod schemas). It must never reach UP into server, client, or db — only other shared modules and external packages.",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "^src/(server|client|db)/" },
    },
    {
      name: "db-is-foundation",
      comment:
        "src/db (Drizzle schema + libSQL client) is persistence. It may use shared + external packages only — never server logic or client code.",
      severity: "error",
      from: { path: "^src/db/" },
      to: { path: "^src/(server|client)/" },
    },
    {
      name: "client-no-backend-runtime",
      comment:
        "The browser bundle must never pull server/db RUNTIME code. Type-only imports ARE allowed — that is how the client gets the tRPC AppRouter type — so this fires only on real value imports.",
      severity: "error",
      from: { path: "^src/client/" },
      to: { path: "^src/(server|db)/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "server-no-client",
      comment: "Server code must never import the browser/presentation layer.",
      severity: "error",
      from: { path: "^src/server/" },
      to: { path: "^src/client/" },
    },
    {
      name: "below-drivers-no-driver",
      comment:
        "Drivers (trpc transport + jobs) sit ABOVE infra + domain and call DOWN into them — never the reverse. Providers, embeddings, auth, and domain must not import a driver layer.",
      severity: "error",
      from: { path: "^src/server/(providers|embeddings|auth|domain)/" },
      to: { path: "^src/server/(trpc|jobs)/" },
    },
    {
      name: "infra-below-domain",
      comment:
        "Domain (business logic) orchestrates infrastructure, not the reverse. Providers, embeddings, and auth are adapters — they must not import the domain layer.",
      severity: "error",
      from: { path: "^src/server/(providers|embeddings|auth)/" },
      to: { path: "^src/server/domain/" },
    },
    {
      name: "observability-is-foundation",
      comment:
        "Logging/observability is a foundation utility (like env) that every layer imports via getLog(). It must not reach UP into domain, the drivers, or the client.",
      severity: "error",
      from: { path: "^src/server/observability/" },
      to: { path: ["^src/server/(domain|trpc|jobs)/", "^src/client/"] },
    },
    {
      name: "drivers-through-domain",
      comment:
        "Drivers stay THIN: tRPC routers AND background jobs reach the database and infrastructure adapters THROUGH the domain layer, never directly. Keeps query/search/embedding/conversion logic in domain (testable in isolation) instead of sprawled across routers or workers. Drivers may still import domain, shared, env, and version.",
      severity: "error",
      from: { path: "^src/server/(trpc|jobs)/" },
      to: { path: ["^src/db/", "^src/server/(providers|embeddings|auth)/"] },
    },
    {
      name: "no-cross-driver",
      comment:
        "Transport (trpc) and background jobs are independent drivers — neither imports the other. Shared work lives in the domain layer they both call down into.",
      severity: "error",
      from: { path: "^src/server/(trpc|jobs)/" },
      to: { path: "^src/server/(trpc|jobs)/", pathNot: "^src/server/$1/" },
    },
    {
      name: "not-to-dev-dep",
      comment:
        "Production code (src) must not depend on devDependencies. Type-only imports and .d.ts ambient references (e.g. vite/client, @types/*) are exempt.",
      severity: "error",
      from: { path: "^src/", pathNot: ["\\.(test|spec)\\.[jt]sx?$", "\\.d\\.(c|m)?ts$"] },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
    {
      name: "not-to-test",
      comment: "Production code must not import test or spec files.",
      severity: "error",
      from: { path: "^src/", pathNot: "\\.(test|spec)\\.[jt]sx?$" },
      to: { path: ["\\.(test|spec)\\.[jt]sx?$", "^tests/"] },
    },
    {
      name: "client-ui-is-pure",
      comment:
        "UI primitives (components/ui — shadcn) are app-agnostic. They must not import routes, client state, or feature components — only lib utils, shared, and other primitives.",
      severity: "error",
      from: { path: "^src/client/components/ui/" },
      to: {
        path: ["^src/client/routes/", "^src/client/state/", "^src/client/components/(?!ui/)"],
      },
    },
    {
      name: "client-routes-are-leaves",
      comment:
        "Route modules are entered only by the generated route tree. Nothing else in the client should import a route.",
      severity: "error",
      from: { path: "^src/client/", pathNot: "^src/client/routes/" },
      to: { path: "^src/client/routes/" },
    },
    {
      name: "client-state-below-view",
      comment:
        "Client state (zustand stores) sits below the view. It must not import components or routes.",
      severity: "error",
      from: { path: "^src/client/state/" },
      to: { path: ["^src/client/components/", "^src/client/routes/"] },
    },
    {
      name: "client-lib-is-foundation",
      comment:
        "Client lib (tRPC client, utils) is the client foundation. It must not import components, routes, or state.",
      severity: "error",
      from: { path: "^src/client/lib/" },
      to: { path: ["^src/client/components/", "^src/client/routes/", "^src/client/state/"] },
    },
    {
      name: "client-foundations-no-features",
      comment:
        "The shared/foundation tiers (lib, state, hooks, components incl. ui primitives) sit BELOW features and must never import a feature. Routes may import features (that's the point); features import these freely.",
      severity: "error",
      from: { path: "^src/client/(lib|state|hooks|components)/" },
      to: { path: "^src/client/features/" },
    },
    {
      name: "client-no-cross-feature",
      comment:
        "Client features stay independent: a module in features/<feature>/ must not import another feature's internals. Shared client-feature helpers live in features/_shared/. (Mirror of domain-no-cross-feature.)",
      severity: "error",
      from: { path: "^src/client/features/([^/]+)/" },
      to: {
        path: "^src/client/features/([^/]+)/",
        pathNot: ["^src/client/features/$1/", "^src/client/features/_shared/"],
      },
    },
    {
      name: "client-feature-front-door",
      comment:
        "Enter a client feature through its PUBLIC API (features/<feature>/index.ts), not its internals — so a route (or anything above) can't reach into a feature's guts. Barrels are scoped on for these index files in biome.jsonc; see docs/architecture.md.",
      severity: "error",
      from: { pathNot: "^src/client/features/" },
      to: {
        path: "^src/client/features/[^/]+/.+",
        pathNot: ["^src/client/features/[^/]+/index\\.ts$", "^src/client/features/_shared/"],
      },
    },
    {
      name: "domain-no-cross-feature",
      comment:
        "Domain features stay independent: a module in domain/<feature>/ must not import another feature's internals. Shared domain helpers live in domain/_shared/.",
      severity: "error",
      from: { path: "^src/server/domain/([^/]+)/" },
      to: {
        path: "^src/server/domain/([^/]+)/",
        pathNot: ["^src/server/domain/$1/", "^src/server/domain/_shared/"],
      },
    },
    {
      name: "domain-feature-front-door",
      comment:
        "Enter a domain feature through its PUBLIC API (domain/<feature>/index.ts), not its internals. Callers above the feature (drivers, the entry) may import the index or domain/_shared only — so a feature can refactor its internals freely. This is the one place we accept barrel files (noBarrelFile is scoped off for these index.ts in biome.jsonc; see docs/architecture.md).",
      severity: "error",
      from: { pathNot: "^src/server/domain/" },
      to: {
        path: "^src/server/domain/[^/]+/.+",
        pathNot: ["^src/server/domain/[^/]+/index\\.ts$", "^src/server/domain/_shared/"],
      },
    },
    {
      // Override the inherited (error) no-orphans: knip is our dead-code
      // authority, so this is a soft secondary signal with entry points and
      // generated/declaration files exempted.
      name: "no-orphans",
      comment:
        "Likely dead code (no importers and no imports). knip owns dead-code detection; this is a secondary warning. Entry points, dotfile configs, and .d.ts files are exempt.",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(c|m)?(js|ts)$",
          "\\.d\\.(c|m)?ts$",
          "(^|/)tsconfig\\.json$",
          "^src/server/index\\.ts$",
          "^src/client/main\\.tsx$",
        ],
      },
      to: {},
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    // Surface type-only imports in the graph so `dependencyTypesNot: ["type-only"]`
    // can distinguish them (the client → server tRPC type bridge).
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      // Imports are extensionless + ESM (tsconfig moduleResolution: bundler).
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".json"],
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
    // Generated by the TanStack Router plugin — not ours to police.
    exclude: { path: "routeTree\\.gen\\.ts$" },
    // content strategy (not the git-metadata default) so caching works before
    // the first commit and in CI checkouts without full history.
    cache: { strategy: "content" },
    reporterOptions: {
      dot: { collapsePattern: "^src/(server/[^/]+|client/[^/]+|shared|db)" },
      archi: { collapsePattern: "^src/(server/[^/]+|client/[^/]+|shared|db)" },
    },
  },
};
