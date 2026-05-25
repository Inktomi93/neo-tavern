import { defineConfig } from "vitest/config";

// Testing doctrine lives in tests/AGENTS.md. When client/component tests land,
// split this into node + happy-dom `projects` (see that doc for the target config).
export default defineConfig({
  test: {
    environment: "node",
    // Scope to OUR tests only — the default glob would otherwise run the test
    // suites inside references/ (the cloned SillyTavern/Astra/Marinara repos).
    // tests/e2e is Playwright's (its own runner), never vitest's.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "tests/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "references/**", "tests/e2e/**"],
    // No tests yet (lean boot). Keep `pnpm check` green until Phase 2 adds them.
    passWithNoTests: true,
  },
});
