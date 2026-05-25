import process from "node:process";
import { and, eq } from "drizzle-orm";
import { createDb, runMigrations } from "../src/db/client";
import { embeddings } from "../src/db/schema";
import { collectEmbedTargets } from "../src/server/domain/corpus";
import { env } from "../src/server/env";

/**
 * Backfill `embeddings.source_text` (4.6.3b) for rows embedded before the column existed —
 * the reranker needs the doc text and re-segmenting chats at query time is too expensive.
 * Re-derives the embed text via `collectEmbedTargets` (the SAME builder the embed pass uses)
 * and writes it WITHOUT re-embedding (the vectors are fine; only the text cache is missing).
 *
 * Drift guard: fills NULL source_text unconditionally, but NEVER silently overwrites an
 * existing non-null value that differs from the re-derived text — that would put text that
 * doesn't match the stored vector (e.g. a card edited post-embed) and mislead the reranker.
 * Such rows are counted + left alone; a non-zero "changed" count means re-embed those.
 */
async function main(): Promise<void> {
  console.log(`[backfill] DB ${env.DATABASE_URL}`);
  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);

  const targets = await collectEmbedTargets(db);
  console.log(`[backfill] ${targets.length} targets re-derived; matching embedding rows…`);

  let filled = 0;
  let alreadyOk = 0;
  let changed = 0;
  let noRow = 0;
  for (const t of targets) {
    const rows = await db
      .select({ id: embeddings.id, sourceText: embeddings.sourceText })
      .from(embeddings)
      .where(and(eq(embeddings.entityType, t.entityType), eq(embeddings.entityId, t.entityId)));
    if (rows.length === 0) {
      noRow += 1; // target was never embedded (e.g. a degenerate card) — nothing to fill
      continue;
    }
    for (const r of rows) {
      if (r.sourceText === null) {
        await db.update(embeddings).set({ sourceText: t.text }).where(eq(embeddings.id, r.id));
        filled += 1;
      } else if (r.sourceText === t.text) {
        alreadyOk += 1;
      } else {
        changed += 1; // text drifted from the stored vector — leave it, flag below
      }
    }
  }

  console.log(
    `[backfill] ✅ filled ${filled} · ${alreadyOk} already-correct · ${noRow} targets without a row`,
  );
  if (changed > 0) {
    console.warn(
      `[backfill] ⚠️  ${changed} rows have source_text that DIFFERS from the re-derived text ` +
        `(vector may be stale) — NOT overwritten. Re-embed those entities to reconcile.`,
    );
  }
}

await main().catch((error: unknown) => {
  console.error("[backfill] failed:", error);
  process.exitCode = 1;
});
