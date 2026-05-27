import process from "node:process";
import { eq } from "drizzle-orm";
import { createDb, runMigrations } from "../src/db/client";
import { chats } from "../src/db/schema";
import { generateDigests } from "../src/server/domain/chat/memory";
import { createEmbedder } from "../src/server/embeddings/embedder";
import { createSummarizer } from "../src/server/embeddings/summarizer";
import { env } from "../src/server/env";

/**
 * Bulk-backfill the {{memory}} structured digests for existing / imported chats — the same
 * `generateDigests` pipeline the live post-turn path uses, just replayed start-to-finish (tier-0
 * blocks → consolidation). Idempotent/incremental: re-running only (re)writes stale/missing
 * digests. Honors the local-first summarizer (set SUMMARIZER_GGUF + EMBED_DEVICE=cuda for the free
 * GPU path, à la scripts/memory-demo-gpu.sh) and falls back to hosted Haiku (OPENROUTER_API_KEY).
 *
 *   pnpm memory:backfill <chatId>   # one chat
 *   pnpm memory:backfill --all      # every chat
 *
 * Uses a default-ENABLED, tiered config so it generates regardless of a chat's preset (you can flip
 * the {{memory}} knob on per-preset later — the digests are already built).
 */
const PARAMS = {
  enabled: true,
  mode: "tiered" as const,
  blockSize: 16,
  verbatimWindow: 30,
  fanOut: 8,
  maxTier: 2,
};

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: pnpm memory:backfill <chatId|--all>");
    process.exit(1);
  }

  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);
  const embedder = createEmbedder();
  const summarizer = createSummarizer();

  const targets =
    arg === "--all"
      ? await db.select({ id: chats.id }).from(chats)
      : await db.select({ id: chats.id }).from(chats).where(eq(chats.id, arg));
  if (targets.length === 0) {
    console.error(
      arg === "--all" ? "[backfill] no chats found" : `[backfill] chat ${arg} not found`,
    );
    process.exit(1);
  }

  console.log(
    `[backfill] DB ${env.DATABASE_URL} · ${targets.length} chat(s) · embed=${env.EMBED_DEVICE} · summarizer=${env.SUMMARIZER_GGUF ? "local" : "hosted"}`,
  );
  let total = 0;
  for (const c of targets) {
    const { written } = await generateDigests(
      db,
      { embedder, summarizer },
      {
        chatId: c.id,
        params: PARAMS,
      },
    );
    total += written;
    console.log(`[backfill] ${c.id}: ${written} digest(s) (re)written`);
  }
  console.log(`[backfill] done — ${total} digest(s) across ${targets.length} chat(s)`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
