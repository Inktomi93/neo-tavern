import { expect, test } from "vitest";
import { DEFAULTS } from "./constants";
import { parseDigest, resolveCfg } from "./utils";

// ── parseDigest ────────────────────────────────────────────────────────────────
// The structured-output parser the summarizer feeds. JSON-first (the local grammar-constrained path
// + the hosted path both emit JSON), with a legacy free-text fallback. These pin every branch — the
// JSON path in particular is only ever exercised INDIRECTLY elsewhere (the fake summarizer emits the
// free-text shape), so its behavior was previously unverified.

test("parseDigest: valid JSON → reconstructed anchor + bulleted facts + keywords", () => {
  const r = parseDigest(
    '{"topicAnchor":"[Roan — the brass key]","facts":["a","b"],"keywords":["k1","k2"]}',
  );
  expect(r.topicAnchor).toBe("[Roan — the brass key]");
  expect(r.text).toBe("[Roan — the brass key]\n- a\n- b");
  expect(r.keywords).toEqual(["k1", "k2"]);
});

test("parseDigest: JSON wrapped in stray prose → the outermost {...} is sliced out and parsed", () => {
  const r = parseDigest('Sure! {"topicAnchor":"X","facts":["f"],"keywords":["k"]} — done.');
  expect(r.topicAnchor).toBe("X");
  expect(r.text).toBe("X\n- f");
  expect(r.keywords).toEqual(["k"]);
});

test("parseDigest: malformed JSON (parse throws) → empty, NOT a stored '{…' fragment", () => {
  const r = parseDigest("{not valid json}");
  expect(r).toEqual({ text: "", topicAnchor: null, keywords: [] });
});

test("parseDigest: truncated JSON with no closing brace → empty (the b21/b24 dump guard)", () => {
  const r = parseDigest('{"topicAnchor": "X", "facts": ["a"');
  expect(r.text).toBe("");
});

test("parseDigest: valid JSON but no anchor AND no facts → treated as empty (skipped)", () => {
  const r = parseDigest('{"keywords":["k1","k2"]}');
  expect(r).toEqual({ text: "", topicAnchor: null, keywords: [] });
});

test("parseDigest: free-text legacy shape → body + comma/semicolon KEYWORDS line", () => {
  const r = parseDigest(
    "[scene anchor]\n- fact one\n- fact two\nKEYWORDS: brass key, lantern; archive",
  );
  expect(r.topicAnchor).toBe("[scene anchor]");
  expect(r.text).toBe("[scene anchor]\n- fact one\n- fact two");
  expect(r.keywords).toEqual(["brass key", "lantern", "archive"]);
});

test("parseDigest: free-text KEYWORDS is case-insensitive", () => {
  const r = parseDigest("summary line\nKeYwOrDs: a; b, c");
  expect(r.keywords).toEqual(["a", "b", "c"]);
  expect(r.text).toBe("summary line");
});

test("parseDigest: free-text with no KEYWORDS line → empty keywords, anchor = first non-empty line", () => {
  const r = parseDigest("[anchor]\n- only fact");
  expect(r.topicAnchor).toBe("[anchor]");
  expect(r.keywords).toEqual([]);
});

test("parseDigest: empty / whitespace-only input → fully empty result", () => {
  expect(parseDigest("")).toEqual({ text: "", topicAnchor: null, keywords: [] });
  expect(parseDigest("   \n  ")).toEqual({ text: "", topicAnchor: null, keywords: [] });
});

test("parseDigest: non-string facts/keywords are filtered; blank keywords dropped; anchor trimmed", () => {
  const r = parseDigest(
    '{"topicAnchor":"  Spaced  ","facts":["good",123,null,"two"],"keywords":["k1",5,"","  "]}',
  );
  expect(r.topicAnchor).toBe("Spaced");
  expect(r.text).toBe("Spaced\n- good\n- two");
  expect(r.keywords).toEqual(["k1"]);
});

// ── resolveCfg ───────────────────────────────────────────────────────────────
// Locks the default CONTRACT: changing a DEFAULTS value (or the `enabled ?? false` opt-in) silently
// changes production behavior, so the resolved shape is asserted explicitly.

test("resolveCfg: an empty config resolves to the documented defaults (memory off by default)", () => {
  expect(resolveCfg({})).toEqual({
    enabled: false, // opt-in: NOT in DEFAULTS, hard-coded false
    blockSize: DEFAULTS.blockSize,
    verbatimWindow: DEFAULTS.verbatimWindow,
    queryWindow: DEFAULTS.queryWindow,
    mode: DEFAULTS.mode,
    fanOut: DEFAULTS.fanOut,
    maxTier: DEFAULTS.maxTier,
    retrieveK: DEFAULTS.retrieveK,
    rerankTo: DEFAULTS.rerankTo,
    minScore: DEFAULTS.minScore,
    keywordMatch: DEFAULTS.keywordMatch,
    recencyBias: DEFAULTS.recencyBias,
    summarizerSource: undefined,
    summarizerMaxTokens: undefined,
    summarizerTemperature: undefined,
  });
});

test("resolveCfg: provided values override; untouched knobs keep their defaults", () => {
  const cfg = resolveCfg({
    enabled: true,
    blockSize: 3,
    mode: "mixA",
    summarizer: { source: "hosted", maxTokens: 100, temperature: 0.5 },
  });
  expect(cfg.enabled).toBe(true);
  expect(cfg.blockSize).toBe(3);
  expect(cfg.mode).toBe("mixA");
  expect(cfg.verbatimWindow).toBe(DEFAULTS.verbatimWindow); // untouched → default
  expect(cfg.summarizerSource).toBe("hosted");
  expect(cfg.summarizerMaxTokens).toBe(100);
  expect(cfg.summarizerTemperature).toBe(0.5);
});
