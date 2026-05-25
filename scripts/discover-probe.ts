import process from "node:process";
import { createDb } from "../src/db/client";
import { createSearchService } from "../src/server/domain/search";
import { env } from "../src/server/env";

/**
 * Validate `discover` (Phase 4.6.3c) on the real corpus: run thematic queries and print the
 * CHARACTERS they surface (not raw segments) with their best matching conversation snippet.
 * Pass `--rerank` to exercise the two-stage path. (Counterpart to `pnpm rerank:probe`.)
 */
async function main(): Promise<void> {
  const rerank = process.argv.includes("--rerank");
  console.log(
    `[discover-probe] DB ${env.DATABASE_URL} · embed=${env.EMBED_DEVICE} · rerank=${rerank}`,
  );
  const db = await createDb(env.DATABASE_URL);
  const search = createSearchService(db);
  const queries = ["comforting someone who is crying", "a tense arena fight", "a first kiss"];
  for (const q of queries) {
    const chars = await search.discover({ queryText: q, k: 5, rerank });
    console.log(`\n## "${q}" → ${chars.length} characters`);
    for (const c of chars) {
      const snip = (c.segments[0]?.snippet ?? "").replace(/\s+/g, " ").slice(0, 90);
      console.log(
        `  ${c.name} (${c.matchCount} segs, best ${c.bestDistance.toFixed(3)}) — ${snip}…`,
      );
    }
  }
}

await main().catch((error: unknown) => {
  console.error("[discover-probe] failed:", error);
  process.exitCode = 1;
});
