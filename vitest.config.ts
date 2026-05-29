import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Testing doctrine lives in tests/AGENTS.md. When client/component tests land,
// split this into node + happy-dom `projects` (see that doc for the target config).
export default defineConfig({
  resolve: {
    alias: { "@": new URL("./src/client", import.meta.url).pathname },
  },
  test: {
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          // Pin a deterministic auth env so the suite is independent of a developer's local .env
          // (which carries deployment config — AUTH_MODE=oidc, a real DEFAULT_USER_HANDLE, etc.).
          // env.ts uses override:false under VITEST so these win over .env (other .env keys still load).
          env: {
            DEFAULT_USER_HANDLE: "owner",
            AUTH_MODE: "single-user",
            AUTH_FALLBACK: "owner",
          },
          include: [
            "src/server/**/*.test.ts",
            "src/shared/**/*.test.ts",
            // All non-e2e tests under tests/ (integration + shared + server) — NOT just
            // tests/integration, which silently dropped tests/shared + tests/server. e2e is
            // excluded at the top level.
            "tests/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "client",
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
          include: ["src/client/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/support/setup-dom.ts"],
        },
      },
    ],
    isolate: false,
    exclude: ["**/node_modules/**", "**/dist/**", "references/**", "tests/e2e/**"],
    restoreMocks: true,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["**/*.test.*", "**/routeTree.gen.ts", "src/**/index.ts"],
    },
  },
});
