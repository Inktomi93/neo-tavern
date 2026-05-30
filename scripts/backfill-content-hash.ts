import process from "node:process";
import { and, eq, isNull } from "drizzle-orm";
import { createDb, runMigrations } from "../src/db/client";
import { chatDigests, chatSegments } from "../src/db/schema";
import { loadChatMeta, loadHistory } from "../src/server/domain/chat/memory/db";
import { renderTranscript } from "../src/server/domain/chat/memory/utils";
import { env } from "../src/server/env";
import { contentHash } from "../src/shared/content-hash";

/**
 * One-shot backfill of `content_hash` on the EXISTING `chat_segments` + tier-0 `chat_digests` rows —
 * the fork/import duplication-collapse key (docs/planning/breadth-buildout.md B.5.1). New rows get it
 * at generation time (`generateSegments`/`generateDigests`); this fills the substrate that was embedded
 * before the column existed. Idempotent: only rows with a NULL `content_hash` are touched, so re-runs
 * are cheap no-ops.
 *
 * - **Segments:** the stored `text` IS the rendered raw block → hash it directly (no message reload).
 * - **tier-0 digests:** the stored `text` is the LLM summary (non-deterministic) — re-render the SOURCE
 *   span (`seqStart..seqEnd` of the chat's filtered history) and hash THAT, matching generation exactly.
 * - **tier 1+ digests:** consolidations have no single raw source → left NULL (the collapse keeps them).
 *
 *   pnpm tsx scripts/backfill-content-hash.ts
 */
async function main(): Promise<void> {
  console.log(`[content-hash] DB ${env.DATABASE_URL}`);
  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);

  // ── segments: hash the stored rendered text ──────────────────────────────────
  const segs = await db
    .select({ id: chatSegments.id, text: chatSegments.text })
    .from(chatSegments)
    .where(isNull(chatSegments.contentHash));
  let segWritten = 0;
  for (const s of segs) {
    await db
      .update(chatSegments)
      .set({ contentHash: contentHash(s.text) })
      .where(eq(chatSegments.id, s.id));
    segWritten += 1;
  }
  console.log(`[content-hash] segments: ${segWritten}/${segs.length} hashed`);

  // ── tier-0 digests: re-render the SOURCE span per chat, then hash ─────────────
  const digs = await db
    .select({
      id: chatDigests.id,
      chatId: chatDigests.chatId,
      seqStart: chatDigests.seqStart,
      seqEnd: chatDigests.seqEnd,
    })
    .from(chatDigests)
    .where(and(eq(chatDigests.tier, 0), isNull(chatDigests.contentHash)));

  // Group by chat so we load each chat's history (+ display names) exactly once.
  const byChat = new Map<string, typeof digs>();
  for (const d of digs) {
    const list = byChat.get(d.chatId) ?? [];
    list.push(d);
    byChat.set(d.chatId, list);
  }
  let digWritten = 0;
  let skipped = 0;
  for (const [chatId, rows] of byChat) {
    const meta = await loadChatMeta(db, chatId);
    if (!meta) {
      skipped += rows.length;
      continue;
    }
    const history = await loadHistory(db, chatId); // same filter generation used (no system/empty)
    for (const d of rows) {
      const span = history.filter((m) => m.seq >= d.seqStart && m.seq <= d.seqEnd);
      if (span.length === 0) {
        skipped += 1;
        continue;
      }
      const rendered = renderTranscript(span, meta.charName, meta.userName);
      await db
        .update(chatDigests)
        .set({ contentHash: contentHash(rendered) })
        .where(eq(chatDigests.id, d.id));
      digWritten += 1;
    }
  }
  console.log(
    `[content-hash] tier-0 digests: ${digWritten}/${digs.length} hashed (${skipped} skipped — no source span)`,
  );
  console.log("[content-hash] ✅ done (tier 1+ left null by design)");
}

await main().catch((error: unknown) => {
  console.error("[content-hash] failed:", error);
  process.exitCode = 1;
});
