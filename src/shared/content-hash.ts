import { createHash } from "node:crypto";

// Fork/import duplication hygiene — the corpus-hygiene invariant (docs/planning/breadth-buildout.md
// B.5.1). A chat fork (and an ST branch re-import) copies the shared message prefix into a new chatId,
// which re-embeds as near-identical `chat_segments`/`chat_digests` rows. That duplication is REQUIRED
// for per-chat in-chat memory but POLLUTES every cross-chat consumer (corpus search + all-pairs
// analytics: dedup, co-occurrence, themes, CSLS hubness). The fix lives at query/aggregation time, not
// storage: tag each row with a content identity and collapse on it. Foundation-layer (pure, no deps)
// so corpus, search, and scripts can all share one primitive.

/**
 * Stable identity for a block of SOURCE conversation text — sha256 hex of the rendered raw transcript.
 *
 * HASH THE SOURCE, NEVER AN LLM DIGEST. Digest text is non-deterministic (the summarizer runs at a
 * temperature), so two forks summarizing byte-identical messages yield different digest strings → a
 * digest-text hash would miss true duplicates. The rendered raw message span is byte-identical across a
 * fork, so hashing it is exact. For segments the embedded `text` IS the rendered source, so hashing it
 * doubles as "rows that produce the same embedding".
 */
export function contentHash(sourceText: string): string {
  return createHash("sha256").update(sourceText).digest("hex");
}

export interface Collapsible {
  /** sha256 of the row's SOURCE span; null when no source identity exists (e.g. tier 1+ consolidations). */
  contentHash: string | null;
}

export interface CollapseResult<T> {
  /** One representative per distinct content (first occurrence in input order); null-hash rows all kept. */
  representatives: T[];
  /** How many rows were dropped as duplicates (input length − representatives length). */
  duplicateCount: number;
  /** Every member per content hash (size > 1 ⇒ duplicated) — powers "also in N chats". */
  membersByHash: Map<string, T[]>;
}

/**
 * Collapse content duplicates to one representative each, at query/aggregation time. Rows with a null
 * `contentHash` are ALWAYS kept (no identity to collapse on). Mechanism-agnostic: catches fork prefixes,
 * branch re-imports, and shared openings (no lineage edge) alike — content identity, not lineage. Run
 * this BEFORE any all-pairs pass (dedup/co-occurrence/k-means/hubness) and BEFORE the ≥0.92 near-dup
 * cosine pass, so trivial exact dups don't double-count or drown the genuine near-dup signal.
 */
export function collapseByContentHash<T extends Collapsible>(
  rows: readonly T[],
): CollapseResult<T> {
  const membersByHash = new Map<string, T[]>();
  const representatives: T[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const h = row.contentHash;
    if (h === null) {
      representatives.push(row);
      continue;
    }
    const members = membersByHash.get(h);
    if (members === undefined) {
      membersByHash.set(h, [row]);
    } else {
      members.push(row);
    }
    if (!seen.has(h)) {
      seen.add(h);
      representatives.push(row);
    }
  }
  return { representatives, duplicateCount: rows.length - representatives.length, membersByHash };
}
