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
          include: [
            "src/server/**/*.test.ts",
            "src/shared/**/*.test.ts",
            "tests/integration/**/*.test.ts",
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
