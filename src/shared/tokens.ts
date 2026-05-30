// The ONE generic, model-agnostic token estimator — for UI/field/prompt-size displays where ST
// reaches for its per-model tokenizer zoo (claude.json, tiktoken, sentencepiece). We deliberately
// do NOT mirror that zoo: there is no public Claude-3+ tokenizer, counts vary per model anyway, and
// OpenRouter's own guidance is "don't pre-estimate — read the response `usage`". So this is an
// advisory estimate, not billing truth. Truth = the provider `usage` we capture post-turn.
//
// Algorithm = OpenRouter's "QuadChars": every 4 printable-ASCII chars ≈ 1 token, and each other
// codepoint (control char, accented letter, CJK, emoji) ≈ 1 token. That makes our number track
// OpenRouter's *normalized* (cross-model) count — a nice consistency property — while staying a
// pure, zero-dependency, O(n) function that runs anywhere (server today, client later) with no
// vocab file and no native binary. It is NOT biased high: for a number shown next to a field, an
// honest estimate beats a conservative one (the budget-bar "round up" instinct belongs elsewhere).
//
// Want real subword counts somewhere precision matters? The seam is open: the native
// `@anush008/tokenizers` runtime (already used in `server/embeddings/tokenizer.ts`) can load any
// HF `tokenizer.json` (e.g. an o200k proxy) without touching this module.

const PRINTABLE_ASCII_LOW = 0x20; // space
const PRINTABLE_ASCII_HIGH = 0x7e; // tilde
const CHARS_PER_TOKEN = 4;

/**
 * Generic token estimate for one string. Model-agnostic (see file header). Returns 0 for empty.
 *
 * `for…of` iterates Unicode codepoints (surrogate pairs handled), so a non-ASCII codepoint — an
 * accented letter, a CJK character, or each codepoint of a multi-codepoint emoji — counts as 1.
 */
export function estimateTokens(text: string): number {
  let printableAscii = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= PRINTABLE_ASCII_LOW && cp <= PRINTABLE_ASCII_HIGH) {
      printableAscii++;
    } else {
      other++;
    }
  }
  return Math.ceil(printableAscii / CHARS_PER_TOKEN) + other;
}

/** Same estimate over many strings, in input order. */
export function estimateTokensBatch(texts: readonly string[]): number[] {
  return texts.map(estimateTokens);
}
