import type { Db } from "../../../../db/client";
import { loadDigests, recentQueryText } from "./db";
import type { DigestRow, MemoryConfig, RetrieveMemoryDeps } from "./types";
import { cosineSim, resolveCfg } from "./utils";

export function formatBlock(digests: DigestRow[]): string | null {
  const block = digests
    .map((d) => d.text.trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
  return block.length > 0 ? block : null;
}

/**
 * The formatted memory block for this chat's NEXT turn (the {{memory}} marker wraps it), or null.
 * mixA = all tier-0 chronological; tiered = the bridge (coarse high-tier for the distant past + the
 * uncovered tier-0 tail); mixB/mixC = vector (+keyword) retrieve the most relevant tier-0 digests,
 * mixC additionally cross-encoder reranks. Always presented chronologically by seqStart.
 */
export async function retrieveMemory(
  db: Db,
  deps: RetrieveMemoryDeps,
  opts: { chatId: string; params: MemoryConfig },
): Promise<string | null> {
  const cfg = resolveCfg(opts.params);
  if (!cfg.enabled || cfg.mode === "off") return null;
  const digests = await loadDigests(db, opts.chatId);
  if (digests.length === 0) return null;

  const bySeq = (a: DigestRow, b: DigestRow) => a.seqStart - b.seqStart;
  const tier0 = digests.filter((d) => d.tier === 0).sort(bySeq);

  if (cfg.mode === "mixA") return formatBlock(tier0);

  // tiered: every digest NOT covered by a higher-tier consolidation = coarse-old + fine-recent.
  if (cfg.mode === "tiered") {
    const covered = (d: DigestRow) =>
      digests.some((c) => c.tier > d.tier && c.seqStart <= d.seqStart && c.seqEnd >= d.seqEnd);
    return formatBlock(digests.filter((d) => !covered(d)).sort(bySeq));
  }

  // mixB / mixC — retrieve the most relevant tier-0 digests for the current scene.
  const query = await recentQueryText(db, opts.chatId, cfg.queryWindow);
  if (query.length === 0) return formatBlock(tier0);
  const qv = await deps.embedder.embed(query);
  // Recency nudge (reviewer #2): a mild boost toward more-recent digests, scaled by recencyBias
  // (0 = off). Inclusion stays on raw cosine vs minScore; recency only reorders the kept set.
  const maxSeqStart = Math.max(1, ...tier0.map((d) => d.seqStart));
  const recency = (d: DigestRow): number => cfg.recencyBias * (d.seqStart / maxSeqStart);
  const scored: { d: DigestRow; score: number }[] = [];
  for (const d of tier0) {
    if (d.embedding === null) continue;
    const score = cosineSim(qv, d.embedding);
    if (score >= cfg.minScore) scored.push({ d, score: score + recency(d) });
  }
  if (cfg.keywordMatch) {
    const qWords = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    // Match on any DISTINCTIVE token (≥4 chars) the keyword shares with the query — so a query
    // saying just "Gundam" hits the "Hi-Nu Gundam" keyword (rare-term recall, the gundam miss),
    // while short words ("the", "of") can't cause false positives (reviewer #3, #4).
    const kwMatches = (kw: string): boolean => {
      const words = kw.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      return words.some((w) => w.length >= 4 && qWords.has(w));
    };
    for (const d of tier0) {
      if (scored.some((s) => s.d === d)) continue;
      if (d.keywords.some(kwMatches)) scored.push({ d, score: cfg.minScore + recency(d) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  let chosen = scored.slice(0, cfg.retrieveK).map((s) => s.d);
  if (cfg.mode === "mixC" && chosen.length > 0) {
    const hits = await deps.reranker.rerank(
      query,
      chosen.map((d) => ({ id: `${d.tier}:${d.blockIdx}`, text: d.text })),
    );
    const order = new Map(hits.map((h, i) => [h.id, i]));
    chosen = [...chosen]
      .sort(
        (a, b) =>
          (order.get(`${a.tier}:${a.blockIdx}`) ?? Number.POSITIVE_INFINITY) -
          (order.get(`${b.tier}:${b.blockIdx}`) ?? Number.POSITIVE_INFINITY),
      )
      .slice(0, cfg.rerankTo);
  }
  if (chosen.length === 0) return null;
  return formatBlock(chosen.sort(bySeq));
}
