import { sql } from "drizzle-orm";
import MiniSearch from "minisearch";
import type { Db } from "../../../db/client";

// Field-scoped fuzzy FULL-TEXT search over character cards (MiniSearch) — the lexical complement to the
// semantic embedding search. The whole-card embedding blurs every field together, so "find cards whose
// SCENARIO mentions a tavern" is impossible with vectors; here the user picks exactly which field(s) to
// search, with real BM25-style relevance, typo tolerance, and prefix (as-you-type) matching.
//
// Tuned per MiniSearch best practice: consistent processTerm (index == query), per-field boosts, fuzzy
// ONLY on meaningful-length terms (cheap + avoids noise), prefix ONLY on the last (being-typed) term.
// The index is built per request over ~300 cards — sub-10ms, always fresh (no stale cache to invalidate).

export const CARD_FIELDS = [
  "name",
  "description",
  "personality",
  "scenario",
  "greetings",
  "exampleMessages",
  "systemPrompt",
  "postHistoryInstructions",
  "creatorNotes",
  "tags",
  "overview", // ── distilled fields below ──
  "elevatorPitch",
  "setting",
  "genre",
  "tone",
] as const;
export type CardField = (typeof CARD_FIELDS)[number];

// Sensible defaults when the caller doesn't restrict fields: the prose body + the distilled summary
// (skips the noisy systemPrompt / postHistoryInstructions unless explicitly asked for).
const DEFAULT_QUERY_FIELDS: CardField[] = [
  "name",
  "description",
  "personality",
  "scenario",
  "greetings",
  "tags",
  "overview",
  "elevatorPitch",
];

// Field boosts — a hit in the name/tags/pitch is worth more than one buried in example messages.
const BOOSTS: Partial<Record<CardField, number>> = {
  name: 6,
  tags: 4,
  elevatorPitch: 3,
  genre: 3,
  tone: 3,
  setting: 2,
  overview: 2,
};

const SNIPPET_PAD = 70;

interface CardDoc extends Record<CardField, string> {
  characterId: string;
}

export interface FieldMatch {
  field: CardField;
  snippet: string;
}

export interface FieldSearchHit {
  characterId: string;
  name: string;
  score: number;
  matches: FieldMatch[];
}

export interface FieldSearchParams {
  q: string;
  /** Which fields/sections to search; default = the prose body + summary. */
  fields?: readonly CardField[] | undefined;
  /** Typo tolerance as an edit-distance ratio (0 = off, ~0.2 = 1 typo per 5 chars). Default 0.2. */
  fuzzy?: number | undefined;
  /** As-you-type prefix matching on the last term. Default true. */
  prefix?: boolean | undefined;
  /** 'AND' = every term must match (precise); 'OR' = any (recall). Default 'AND'. */
  matchMode?: "AND" | "OR" | undefined;
  limit?: number | undefined;
}

async function loadDocs(db: Db, ownerId: string): Promise<CardDoc[]> {
  const rows = await db.all<Record<string, string | null>>(sql`
    SELECT c.id AS characterId, cv.name AS name, cv.description AS description,
           cv.personality AS personality, cv.scenario AS scenario, cv.greetings AS greetings,
           cv.example_messages AS exampleMessages, cv.system_prompt AS systemPrompt,
           cv.post_history_instructions AS postHistoryInstructions, cv.creator_notes AS creatorNotes,
           cv.tags AS tags, cs.overview AS overview, cs.elevator_pitch AS elevatorPitch,
           cs.setting AS setting, cs.genre AS genre, cs.tone AS tone
    FROM characters c
    JOIN character_versions cv ON cv.id = c.current_version_id
    LEFT JOIN character_summaries cs ON cs.character_id = c.id
    WHERE c.owner_id = ${ownerId}
  `);
  return rows.map((row) => {
    const doc = { characterId: String(row["characterId"]) } as CardDoc;
    for (const f of CARD_FIELDS) doc[f] = fieldText(row[f]);
    return doc;
  });
}

function buildIndex(docs: CardDoc[]): MiniSearch<CardDoc> {
  const ms = new MiniSearch<CardDoc>({
    idField: "characterId",
    fields: [...CARD_FIELDS],
    storeFields: ["name"],
    // Same normalization for index AND query (MiniSearch best practice) — lowercase, drop 1-char noise.
    processTerm: (term) => (term.length >= 2 ? term.toLowerCase() : null),
  });
  ms.addAll(docs);
  return ms;
}

export async function fieldSearch(
  db: Db,
  ownerId: string,
  params: FieldSearchParams,
): Promise<FieldSearchHit[]> {
  if (params.q.trim().length === 0) return [];
  const docs = await loadDocs(db, ownerId);
  const ms = buildIndex(docs);
  const byId = new Map(docs.map((d) => [d.characterId, d]));
  const fields =
    params.fields && params.fields.length > 0 ? [...params.fields] : DEFAULT_QUERY_FIELDS;
  const fuzzy = params.fuzzy ?? 0.2;

  const results = ms.search(params.q, {
    fields,
    boost: BOOSTS,
    combineWith: params.matchMode ?? "AND",
    // Prefix only the LAST term (the one being typed) — the as-you-type idiom.
    prefix: (_term, i, terms) => params.prefix !== false && i === terms.length - 1,
    // Fuzzy only on terms long enough to carry a typo — cheaper and far less noisy.
    fuzzy: (term) => (fuzzy > 0 && term.length > 3 ? fuzzy : false),
  });

  return results.slice(0, params.limit ?? 50).map((r) => {
    const doc = byId.get(String(r.id));
    const name = typeof r["name"] === "string" ? r["name"] : (doc?.name ?? "Unknown");
    return {
      characterId: String(r.id),
      name,
      score: r.score,
      matches: matchSnippets(r.match, doc),
    };
  });
}

/** As-you-type suggestions (MiniSearch.autoSuggest) — ranked completions for a partial query. */
export async function fieldSuggest(
  db: Db,
  ownerId: string,
  q: string,
  limit = 8,
): Promise<string[]> {
  if (q.trim().length === 0) return [];
  const ms = buildIndex(await loadDocs(db, ownerId));
  return ms
    .autoSuggest(q, { fuzzy: 0.2, prefix: true })
    .slice(0, limit)
    .map((s) => s.suggestion);
}

// MiniSearch `match` is { term: [fieldNames] }; invert to field → matched terms, then snippet each.
function matchSnippets(match: Record<string, string[]>, doc: CardDoc | undefined): FieldMatch[] {
  if (!doc) return [];
  const byField = new Map<CardField, string[]>();
  for (const [term, fields] of Object.entries(match)) {
    for (const f of fields) {
      const field = f as CardField;
      const list = byField.get(field) ?? [];
      list.push(term);
      byField.set(field, list);
    }
  }
  const out: FieldMatch[] = [];
  for (const [field, terms] of byField) {
    out.push({ field, snippet: snippetAround(doc[field] ?? "", terms) });
  }
  return out;
}

function snippetAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let idx = -1;
  let hit = "";
  for (const t of terms) {
    const at = lower.indexOf(t.toLowerCase());
    if (at >= 0 && (idx < 0 || at < idx)) {
      idx = at;
      hit = t;
    }
  }
  if (idx < 0)
    return text
      .slice(0, SNIPPET_PAD * 2)
      .replace(/\s+/g, " ")
      .trim();
  const start = Math.max(0, idx - SNIPPET_PAD);
  const end = Math.min(text.length, idx + hit.length + SNIPPET_PAD);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

// json columns (greetings/tags) are stored as a json array string → flatten to searchable text.
function fieldText(value: string | null | undefined): string {
  if (value == null) return "";
  const v = value.trim();
  if (v.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(v);
      if (Array.isArray(arr))
        return arr.filter((x): x is string => typeof x === "string").join("\n");
    } catch {
      // fall through — treat as plain text
    }
  }
  return value;
}
