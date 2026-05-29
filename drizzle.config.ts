import process from "node:process";
import { defineConfig } from "drizzle-kit";

// Migration workflow = `generate` (versioned SQL) + programmatic `migrate()`, NEVER
// `push` (dev-only, no history). See docs/corpus-import.md / the ST migrations lesson.
// `dialect: sqlite` targets the local libSQL file; generate diffs schema snapshots and
// needs no DB connection (dbCredentials is only used by push/migrate/studio).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "file:./neo-tavern.db" },
  strict: true,
});
