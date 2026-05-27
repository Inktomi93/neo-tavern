import process from "node:process";
import { createDb, runMigrations } from "../src/db/client";
import {
  collectEmbedTargets,
  createCorpusService,
  type EmbedItem,
  embeddingKey,
  MIN_SEARCH_TEXT_TOKENS,
} from "../src/server/domain/corpus";
import { createBgeTokenizer } from "../src/server/embeddings/tokenizer";
import { env } from "../src/server/env";

/**
 * Embed pass (Phase 4.6.2): index the imported corpus for semantic search. Targets (each
 * character's current-version card + each real_conversation chat's segments) are assembled
 * by `collectEmbedTargets` (domain/corpus — shared with the source_text backfill so the text
 * is built one way). Uses the REAL BGE-M3 tokenizer (native, fast) to: drop degenerate cards
 * (< 150 tok), sort by real length, and pack TOKEN-BUDGET batches (cap padded tokens/batch,
 * not a fixed count — fixed-count + long text OOMs). Resumable (skips already-embedded).
 * Stores source_text per row (for the reranker). GPU via `pnpm embed:corpus:gpu`.
 */
// Padded-token budget per GPU batch (max_seq_len × batch_size). With length-sorting this is
// tight. BGE-M3 (568M) is small, so this is generous for the 48GB A6000s.
const MAX_BATCH_TOKENS = 32768;
const TOKENIZE_CHUNK = 512;

async function main(): Promise<void> {
  console.log(
    `[embed] DB ${env.DATABASE_URL} · device=${env.EMBED_DEVICE} dtype=${env.EMBED_DTYPE} budget=${MAX_BATCH_TOKENS}tok`,
  );
  const db = await createDb(env.DATABASE_URL);
  await runMigrations(db);
  const corpus = createCorpusService(db);
  const tok = createBgeTokenizer();
  const done = await corpus.existingKeys();

  // Build every target ONE way (shared with the source_text backfill), then skip the done.
  const all = await collectEmbedTargets(db);
  const targets = all.filter((t) => !done.has(embeddingKey(t.entityType, t.entityId)));
  const skipped = all.length - targets.length;
  console.log(
    `[embed] ${all.length} targets · ${skipped} already embedded · ${targets.length} to embed`,
  );

  // ── Real token counts → drop degenerate cards → sort → token-budget batch ──
  console.log(`[embed] tokenizing ${targets.length} targets (real BGE-M3)…`);
  const toks: number[] = [];
  for (let b = 0; b < targets.length; b += TOKENIZE_CHUNK) {
    toks.push(...(await tok.countBatch(targets.slice(b, b + TOKENIZE_CHUNK).map((t) => t.text))));
  }
  const withToks = targets
    .map((t, idx) => ({ item: t, tokens: toks[idx] ?? 0 }))
    // degenerate filter: tiny CARDS match everything (still directly retrievable). config.py:76
    .filter((x) => x.item.entityType !== "character" || x.tokens >= MIN_SEARCH_TEXT_TOKENS)
    .sort((a, b) => a.tokens - b.tokens); // length-sort → tight padded batches
  const cardsSkippedSmall =
    targets.filter((t) => t.entityType === "character").length -
    withToks.filter((x) => x.item.entityType === "character").length;

  let embedded = 0;
  let batch: EmbedItem[] = [];
  let batchMax = 0;
  const flush = async (): Promise<void> => {
    if (batch.length > 0) {
      embedded += await corpus.embedAndStoreMany(batch);
      batch = [];
      batchMax = 0;
      console.log(`[embed] ${embedded}/${withToks.length} embedded…`);
    }
  };
  for (const { item, tokens } of withToks) {
    const newMax = Math.max(batchMax, tokens);
    if (batch.length > 0 && newMax * (batch.length + 1) > MAX_BATCH_TOKENS) await flush();
    batch.push(item);
    batchMax = Math.max(batchMax, tokens);
  }
  await flush();

  console.log(
    `[embed] ✅ ${embedded} embedded · ${cardsSkippedSmall} cards too small · ${skipped} already-present skipped`,
  );
}

await main()
  .catch((error: unknown) => {
    console.error("[embed] failed:", error);
    process.exitCode = 1;
  })
  // onnxruntime-node's CUDA EP corrupts the heap in its atexit/static destructors
  // (microsoft/onnxruntime#19768) — a successful run otherwise dies with SIGABRT (134),
  // which under `set -euo pipefail` makes embed:corpus:gpu falsely report failure. Force a
  // clean exit *after* all DB writes have flushed, skipping those native destructors.
  .finally(() => process.exit(process.exitCode ?? 0));
