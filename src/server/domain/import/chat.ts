// SillyTavern chat-JSONL parser — ported from card-curator
// (development/card-curator/src/card_curator/chats.py: parse_send_date, parse_chat_file,
// _normalize_parent_ref) + scripts/check_chat_filters.py (the 4-bucket classifier), with
// st-bridge's lifted refinements (development/st-bridge/src/st_bridge/dates.py): numeric-
// string epochs, is_branch via "Branch #" substring (not startsWith — catches 80 more), and
// the filename-derived parent fallback. The cross-file branch-TREE reconstruction
// (chats.py:615-701 _trace_root / children_of) is NOT here — it needs all of a character's
// chats at once, so it lives in Phase 4.4 orchestration.
// PURE: one file's text in → a ParsedChat out; no I/O, no DB. Orchestration (Phase 4.4)
// maps ParsedChat → chats + messages + message_variants rows and resolves parentRef →
// parentChatId. card-curator only *counts* messages; we keep their content for storage.
//
// JSONL layout: line 0 = header {chat_metadata, user_name, character_name}; lines 1+ =
// messages {name, is_user, is_system, send_date, mes, extra, swipes, swipe_id, swipe_info}.
// Resilient: a corrupt message line is skipped, not fatal (real corpus had 0, but
// docker cp / partial writes happen).

import { z } from "zod";
import { epochToMs, isoToMs } from "../../../shared/time";
import { nullIfEmpty, str } from "./_utils";

export type MessageRole = "user" | "assistant" | "system";

export type ChatBucket = "header_only" | "all_empty_msgs" | "greeting_only" | "real_conversation";

export interface ParsedVariant {
  idx: number; // position in the swipe pool (0-based)
  content: string;
  model: string | null; // swipe_info[idx].extra.model
  provider: string | null; // swipe_info[idx].extra.api
  tokensOut: number | null; // swipe_info[idx].extra.token_count
  genStarted: number | null; // ms epoch
  genFinished: number | null;
}

export interface ParsedChatMessage {
  role: MessageRole;
  content: string; // `mes` — the rendered text (authoritative; can diverge from the active swipe)
  sendDate: number | null; // ms epoch
  model: string | null; // extra.model
  provider: string | null; // extra.api
  tokensOut: number | null; // extra.token_count (ST tracks generated tokens, no per-msg prompt count)
  genStarted: number | null;
  genFinished: number | null;
  activeVariantIdx: number | null; // swipe_id, clamped to a valid index (null if out of range / no swipes)
  variants: ParsedVariant[]; // all swipes, verbatim — empty when ≤1 generation
  raw: unknown; // the whole message line — archival
}

export interface ParsedChat {
  characterName: string; // header character_name with the "unused"/empty → dir-name fallback applied
  userName: string | null;
  createDate: number | null; // ms epoch (header create_date; often absent)
  isBranch: boolean; // filename contains "Branch #" (display hint only; parentRef is the real edge)
  parentRef: string | null; // normalized chat_metadata.main_chat (+.jsonl) — the real branch edge
  notePrompt: string | null; // chat_metadata.note_prompt → a persistent author's-note system msg (later)
  bucket: ChatBucket; // RAG/analytics relevance class — import all, embed only real conversations
  messages: ParsedChatMessage[];
  rawHeader: unknown; // header line — archival (carries chat_metadata)
}

// Permissive typed views over ST's external JSON (snake_case by spec; the biome override for
// import/** allows dot access + these names). Each field is `unknown` and every consuming helper
// already coerces (str/parseStDate/Number) + guards, so the schemas exist to VALIDATE the object
// SHAPE (is this a record at all?) — replacing the blind `asObj(x) as RawFoo` casts — not to reject
// fields. `.passthrough()` keeps unmodelled keys; a non-object fails `safeParse` → null (skip/abort).
const rawHeaderSchema = z
  .object({
    user_name: z.unknown(),
    character_name: z.unknown(),
    create_date: z.unknown(),
    chat_metadata: z.unknown(),
  })
  .partial()
  .passthrough();

const rawExtraSchema = z
  .object({ model: z.unknown(), api: z.unknown(), token_count: z.unknown() })
  .partial()
  .passthrough();

const rawSwipeInfoSchema = z
  .object({ extra: z.unknown(), gen_started: z.unknown(), gen_finished: z.unknown() })
  .partial()
  .passthrough();

const rawMessageSchema = z
  .object({
    is_user: z.unknown(),
    is_system: z.unknown(),
    mes: z.unknown(),
    send_date: z.unknown(),
    extra: z.unknown(),
    swipes: z.unknown(),
    swipe_id: z.unknown(),
    swipe_info: z.unknown(),
    gen_started: z.unknown(),
    gen_finished: z.unknown(),
  })
  .partial()
  .passthrough();
type RawMessage = z.infer<typeof rawMessageSchema>;

/** Validate a value's object shape against a lenient schema; null on a non-object. Replaces the
 *  blind `asObj(x) as RawFoo` cast — the parse actually checks it's a record. */
function asTyped<T>(v: unknown, schema: z.ZodType<T>): T | null {
  const result = schema.safeParse(v);
  return result.success ? result.data : null;
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** Parse ST's many date encodings → epoch ms (UTC). Port of chats.py:parse_send_date
 *  (epoch s/ms · ISO 8601 · ST "2025-07-03@14h56m48s[989ms]" · "August 27, 2025 6:36pm").
 *  ALL formats are interpreted as UTC (`Date.UTC` / the shared UTC parsers) — diverging from
 *  card-curator's local-naive behavior ON PURPOSE: one canonical UTC instant, no server-tz drift
 *  (docs/architecture/data-model.md + shared/time.ts). The client renders in the viewer's zone. */
export function parseStDate(v: unknown): number | null {
  if (v == null || v === "") return null;

  // Epoch (number): ≥1e12 ⇒ already ms; else seconds (the shared seconds-or-ms heuristic).
  if (typeof v === "number") return epochToMs(v);

  const s = String(v).trim();
  if (!s) return null;

  // Numeric-string epoch (st-bridge dates.py:45 — card-curator's chats.py missed this).
  // Guard to ≥10 digits so a bare "2025" isn't misread as 2025 epoch-seconds.
  if (/^\d{10,}$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return epochToMs(n);
  }

  // ISO 8601 (newer ST). Naive (no-offset) ISO is read as UTC — deterministic, unlike Date.parse.
  if (s.includes("T")) {
    const t = isoToMs(s);
    if (t !== null) return t;
  }

  // ST create_date: "2025-07-03@14h56m48s" (+ optional "989ms"), whitespace-tolerant. UTC.
  const at = s.match(/(\d{4})-(\d{2})-(\d{2})\s*@\s*(\d{2})h\s*(\d{2})m\s*(\d{2})s/);
  if (at) {
    const [, y, mo, d, h, mi, se] = at;
    const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
    if (!Number.isNaN(t)) return t;
  }

  // Human readable: "August 27, 2025 6:36pm" (with or without the time). UTC.
  const lower = s.toLowerCase();
  for (const [name, mo] of Object.entries(MONTHS)) {
    if (!lower.includes(name)) continue;
    const withTime = lower.match(
      new RegExp(`${name}\\s+(\\d{1,2}),?\\s+(\\d{4})\\s+(\\d{1,2}):(\\d{2})(am|pm)`),
    );
    if (withTime) {
      const [, d, y, hh, mm, ap] = withTime;
      let hour = Number(hh);
      if (ap === "pm" && hour !== 12) hour += 12;
      else if (ap === "am" && hour === 12) hour = 0;
      const t = Date.UTC(Number(y), mo - 1, Number(d), hour, Number(mm));
      if (!Number.isNaN(t)) return t;
    }
    const dateOnly = lower.match(new RegExp(`${name}\\s+(\\d{1,2}),?\\s+(\\d{4})`));
    if (dateOnly) {
      const [, d, y] = dateOnly;
      const t = Date.UTC(Number(y), mo - 1, Number(d));
      if (!Number.isNaN(t)) return t;
    }
    break;
  }
  return null;
}

/** Normalize a chat_metadata.main_chat ref to filename form (ST stores it without
 *  ".jsonl"). Port of chats.py:_normalize_parent_ref. */
function normalizeParentRef(mainChat: string): string | null {
  if (!mainChat) return null;
  return mainChat.endsWith(".jsonl") ? mainChat : `${mainChat}.jsonl`;
}

/** Fallback parent derivation from the filename (st-bridge dates.py:get_parent_chat):
 *  "CharName - <date> - Branch #N.jsonl" → "CharName - <date>.jsonl". Used when
 *  chat_metadata.main_chat is absent (6 branch files in the real corpus). */
function deriveParentFromFilename(fileName: string): string | null {
  const i = fileName.indexOf(" - Branch #");
  return i >= 0 ? `${fileName.slice(0, i)}.jsonl` : null;
}

function extractExtra(extra: unknown): {
  model: string | null;
  provider: string | null;
  tokensOut: number | null;
} {
  const e = asTyped(extra, rawExtraSchema);
  const tc = e ? Number(e.token_count) : Number.NaN;
  return {
    model: nullIfEmpty(str(e?.model)),
    provider: nullIfEmpty(str(e?.api)),
    tokensOut: Number.isFinite(tc) && tc > 0 ? tc : null,
  };
}

function roleOf(m: RawMessage): MessageRole {
  if (m.is_system === true) return "system";
  return m.is_user === true ? "user" : "assistant";
}

function buildVariants(swipes: unknown[], swipeInfo: unknown): ParsedVariant[] {
  const info = Array.isArray(swipeInfo) ? swipeInfo : [];
  return swipes.map((content, idx) => {
    const si = asTyped(info[idx], rawSwipeInfoSchema); // swipe_info can be shorter than swipes
    const ex = extractExtra(si?.extra);
    return {
      idx,
      content: str(content),
      model: ex.model,
      provider: ex.provider,
      tokensOut: ex.tokensOut,
      genStarted: si ? parseStDate(si.gen_started) : null,
      genFinished: si ? parseStDate(si.gen_finished) : null,
    };
  });
}

/** Classify a chat into the 4 buckets (check_chat_filters.py): import everything, but
 *  embed/analyze only `real_conversation`. greeting_only = no user turn; all_empty_msgs =
 *  only system/blank; header_only = no message lines. */
function classify(messages: ParsedChatMessage[]): ChatBucket {
  if (messages.length === 0) return "header_only";
  const substantive = messages.filter((m) => m.role !== "system" && m.content.trim().length > 0);
  if (substantive.length === 0) return "all_empty_msgs";
  if (!substantive.some((m) => m.role === "user")) return "greeting_only";
  return "real_conversation";
}

/** Parse one ST chat .jsonl. `fileName` (for the Branch-prefix hint) and `charDirName`
 *  (the "unused"/empty character_name fallback) are import context the caller supplies.
 *  Returns null only when the header line itself is unparseable. */
export function parseChatJsonl(
  text: string,
  opts: { fileName: string; charDirName: string },
): ParsedChat | null {
  const lines = text.replace(/^﻿/, "").trim().split("\n");
  if (lines.length === 0 || !lines[0]) return null;

  const header = asTyped(parseJson(lines[0]), rawHeaderSchema);
  if (!header) return null;

  const meta = asObj(header.chat_metadata);
  const rawCharName = str(header.character_name);
  const characterName = !rawCharName || rawCharName === "unused" ? opts.charDirName : rawCharName;

  const messages: ParsedChatMessage[] = [];
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (!t) continue;
    const parsed = asTyped(parseJson(t), rawMessageSchema);
    if (!parsed) continue; // skip a corrupt line, keep going

    const ex = extractExtra(parsed.extra);
    const swipes = Array.isArray(parsed.swipes) ? parsed.swipes : [];
    const hasVariants = swipes.length > 1;

    let activeVariantIdx: number | null = null;
    if (hasVariants) {
      const sid = parsed.swipe_id;
      activeVariantIdx = typeof sid === "number" && sid >= 0 && sid < swipes.length ? sid : null;
    }

    messages.push({
      role: roleOf(parsed),
      content: str(parsed.mes),
      sendDate: parseStDate(parsed.send_date),
      model: ex.model,
      provider: ex.provider,
      tokensOut: ex.tokensOut,
      genStarted: parseStDate(parsed.gen_started),
      genFinished: parseStDate(parsed.gen_finished),
      activeVariantIdx,
      variants: hasVariants ? buildVariants(swipes, parsed.swipe_info) : [],
      raw: parsed,
    });
  }

  return {
    characterName,
    userName: nullIfEmpty(str(header.user_name)),
    createDate: parseStDate(header.create_date),
    // st-bridge is_branch: "Branch #" anywhere — catches both "Branch #N - date.jsonl"
    // AND "CharName - date - Branch #N.jsonl" (the latter, 80 files, the startsWith form missed).
    isBranch: opts.fileName.includes("Branch #"),
    // main_chat is authoritative; fall back to the filename-encoded lineage when absent.
    parentRef:
      normalizeParentRef(str(meta?.["main_chat"])) ?? deriveParentFromFilename(opts.fileName),
    notePrompt: nullIfEmpty(str(meta?.["note_prompt"])),
    bucket: classify(messages),
    messages,
    rawHeader: header,
  };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
