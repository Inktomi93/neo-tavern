// SillyTavern PNG character-card parser — ported from card-curator
// (development/card-curator/src/card_curator/extract.py: `_read_png_text_chunk`,
// `_normalize_card_json`, `parse_card`). PURE: bytes in → a normalized ParsedCard out;
// no file I/O, no DB. The orchestration step (Phase 4.4) maps ParsedCard → our
// `character_versions` + `world_books`/`world_entries` rows.
//
// Cards stash their JSON in a PNG `tEXt` chunk, base64-encoded, under one of two
// keywords: `ccv3` (V3 spec, preferred) or `chara` (V2, fallback). We read the chunk
// by hand — no PNG library needed for a read, and it mirrors SillyTavern's own logic.
//
// Deliberate divergences from card-curator (each load-bearing — see Phase 4 advisor notes):
//   • `cardVersion` is the card's freeform creator string (e.g. "1.0"), kept distinct
//     from our integer `character_versions.version` counter so 4.4 can't conflate them.
//   • lorebook entries are preserved WHOLE and UNFILTERED (we keep disabled ones too —
//     the schema has an `enabled` column; card-curator drops them).
//   • optional text fields normalize empty/whitespace-only → null (one consistent policy).

import { Buffer } from "node:buffer";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export interface ParsedCard {
  /** Card name; never empty — falls back to `fallbackName` (card-curator's third leg). */
  name: string;
  description: string | null;
  personality: string | null;
  scenario: string | null;
  firstMessage: string | null;
  exampleMessages: string | null;
  systemPrompt: string | null;
  postHistoryInstructions: string | null;
  creator: string | null;
  /** The literal "Creator's notes go here." placeholder is stripped. */
  creatorNotes: string | null;
  alternateGreetings: string[];
  tags: string[];
  /** Card's freeform creator version STRING (e.g. "1.0") — NOT our int version counter. */
  cardVersion: string | null;
  /** Full ST lorebook entries, unfiltered — every field preserved. 4.4 maps the known
   *  columns (title/content/legacyKeys/enabled/priority) and stashes the rest in
   *  `world_entries.metadata`. */
  lorebookEntries: Record<string, unknown>[];
  regexScripts: Record<string, unknown>[];
  /** The whole normalized card JSON — archival, stored verbatim in `character_versions.raw`. */
  raw: unknown;
}

// A permissive typed view over the dynamic, multi-spec card JSON. Every field is
// optional `unknown` (cards are untrusted); dot access keeps both useLiteralKeys and
// noPropertyAccessFromIndexSignature happy — and documents exactly what we read.
interface RawCard {
  spec?: unknown;
  data?: unknown;
  name?: unknown;
  description?: unknown;
  personality?: unknown;
  scenario?: unknown;
  first_mes?: unknown;
  mes_example?: unknown;
  system_prompt?: unknown;
  post_history_instructions?: unknown;
  creator?: unknown;
  creator_notes?: unknown;
  creatorcomment?: unknown;
  alternate_greetings?: unknown;
  tags?: unknown;
  character_version?: unknown;
  character_book?: unknown;
  // Pygmalion Gradio variant
  char_name?: unknown;
  char_persona?: unknown;
  char_greeting?: unknown;
  example_dialogue?: unknown;
  world_scenario?: unknown;
  extensions?: {
    regex_scripts?: unknown;
    [key: string]: unknown;
  };
}

function isPng(data: Uint8Array): boolean {
  return data.length >= 8 && PNG_SIGNATURE.every((b, i) => data[i] === b);
}

/** Read a `tEXt` chunk value by keyword (case-insensitive). Verbatim port of
 *  extract.py:`_read_png_text_chunk`, plus bounds-checks (a TS `DataView` throws on OOB
 *  where Python slicing returns empty) so truncated downloads fail soft → null. */
function readPngTextChunk(data: Uint8Array, keyword: string): string | null {
  if (!isPng(data)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder("utf-8");
  const want = keyword.toLowerCase();

  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = view.getUint32(offset, false);
    // chunk layout = length(4) + type(4) + data(length) + crc(4)
    if (offset + 12 + length > data.length) break; // truncated → stop walking
    const chunkType = String.fromCharCode(...data.subarray(offset + 4, offset + 8));

    if (chunkType === "tEXt") {
      const chunk = data.subarray(offset + 8, offset + 8 + length);
      const nullIdx = chunk.indexOf(0);
      if (nullIdx >= 0) {
        const key = decoder.decode(chunk.subarray(0, nullIdx));
        if (key.toLowerCase() === want) {
          return decoder.decode(chunk.subarray(nullIdx + 1));
        }
      }
    }
    offset += 12 + length;
  }
  return null;
}

/** Normalize V1 / Pygmalion-Gradio card JSON to the V2 `{ data: {...} }` shape. Verbatim
 *  port of extract.py:`_normalize_card_json` — detection ORDER matches SillyTavern's
 *  characters.js. Without it ~5–15% of a real corpus fails to import silently. */
function normalizeCardJson(card: RawCard): RawCard {
  if ("spec" in card || "data" in card) return card; // already V2/V3

  if ("char_name" in card) {
    // Pygmalion Gradio format → remap to V2 fields.
    return {
      data: {
        name: card.char_name ?? "",
        description: card.char_persona ?? "",
        first_mes: card.char_greeting ?? "",
        mes_example: card.example_dialogue ?? "",
        scenario: card.world_scenario ?? "",
        personality: "",
        creator: card.creator ?? "",
        creator_notes: card.creator_notes ?? card.creatorcomment ?? "",
        tags: card.tags ?? [],
      },
    };
  }

  if ("name" in card) {
    // V1 — fields at root level; wrap in `data`.
    return {
      data: {
        name: card.name ?? "",
        description: card.description ?? "",
        personality: card.personality ?? "",
        scenario: card.scenario ?? "",
        first_mes: card.first_mes ?? "",
        mes_example: card.mes_example ?? "",
        creator: card.creator ?? "",
        creator_notes: card.creatorcomment ?? card.creator_notes ?? "",
        tags: card.tags ?? [],
      },
    };
  }

  return card;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function nullIfEmpty(s: string): string | null {
  return s.trim().length > 0 ? s : null;
}

function firstNonEmpty(...vals: string[]): string | null {
  for (const v of vals) {
    if (v.trim().length > 0) return v;
  }
  return null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** `character_book.entries` is dict-OR-list in the wild; preserve every entry object. */
function extractLorebook(book: unknown): Record<string, unknown>[] {
  if (typeof book !== "object" || book === null) return [];
  const entries = (book as { entries?: unknown }).entries;
  let list: unknown[];
  if (Array.isArray(entries)) {
    list = entries;
  } else if (typeof entries === "object" && entries !== null) {
    list = Object.values(entries);
  } else {
    return [];
  }
  return list.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
}

/** Parse a SillyTavern character-card PNG. Returns null when the bytes carry no card
 *  data (no `ccv3`/`chara` chunk, malformed PNG, or undecodable base64/JSON). */
export function parseCardPng(bytes: Uint8Array, fallbackName: string): ParsedCard | null {
  const encoded = readPngTextChunk(bytes, "ccv3") ?? readPngTextChunk(bytes, "chara");
  if (!encoded) return null;

  let cardJson: RawCard;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null) return null;
    cardJson = parsed as RawCard;
  } catch {
    return null;
  }

  cardJson = normalizeCardJson(cardJson);
  // V2/V3 nest everything under `data`; post-normalize V1/Pygmalion do too. Fall back to
  // the root object for any odd card that slipped through normalization.
  const data: RawCard =
    typeof cardJson.data === "object" && cardJson.data !== null
      ? (cardJson.data as RawCard)
      : cardJson;

  return {
    name: firstNonEmpty(str(data.name), str(cardJson.name)) ?? fallbackName,
    description: nullIfEmpty(str(data.description)),
    personality: nullIfEmpty(str(data.personality)),
    scenario: nullIfEmpty(str(data.scenario)),
    firstMessage: nullIfEmpty(str(data.first_mes)),
    exampleMessages: nullIfEmpty(str(data.mes_example)),
    systemPrompt: nullIfEmpty(str(data.system_prompt)),
    postHistoryInstructions: nullIfEmpty(str(data.post_history_instructions)),
    creator: nullIfEmpty(str(data.creator)),
    creatorNotes: nullIfEmpty(
      str(data.creator_notes).replace("Creator's notes go here.", "").trim(),
    ),
    alternateGreetings: strArray(data.alternate_greetings),
    tags: strArray(data.tags ?? cardJson.tags),
    cardVersion: nullIfEmpty(str(data.character_version)),
    lorebookEntries: extractLorebook(data.character_book),
    regexScripts: Array.isArray(data.extensions?.regex_scripts)
      ? data.extensions.regex_scripts.filter(
          (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
        )
      : [],
    raw: cardJson,
  };
}
