// Chat segmentation for embedding — ported from card-curator chat_index.py
// (_is_pair_boundary, segment_chat, _format_segment). Splits a conversation into
// overlapping windows that NEVER orphan a user message from its response. Pure; operates
// on our clean message shape (not ST dicts). The embed pass (Phase 4.6.2) feeds it the
// real_conversation chats only.

import { approxTokens, cleanText } from "./embed-text";

// Token budgets (chars/4 approximation). Capped well below BGE-M3's 8192 max seq to leave
// room for an instruction prefix later. card-curator used 4096 for an 8B/32K model.
const TARGET_TOKENS = 2000;
const MIN_TOKENS = 512;
const OVERLAP_RATIO = 0.5;

export interface SegmentMessage {
  isUser: boolean; // drives pair-boundary safety
  speaker: string; // display name for the segment text
  content: string;
  sendDate: number | null;
}

export interface Segment {
  index: number;
  total: number;
  msgStart: number; // inclusive index into the filtered message list
  msgEnd: number;
  text: string; // formatted, ready to embed
  firstDate: number | null;
  lastDate: number | null;
  speakers: string[];
}

/** A safe split point: after a character response, or between two user messages — never
 *  between a user message and its (next) character reply. Port of _is_pair_boundary. */
function isPairBoundary(msgs: SegmentMessage[], idx: number): boolean {
  if (idx >= msgs.length - 1) return true;
  const cur = msgs[idx];
  const next = msgs[idx + 1];
  if (!cur || !next) return true;
  if (!cur.isUser) return true; // after a character response
  if (cur.isUser && next.isUser) return true; // between two user messages
  return false; // user → character: unsafe
}

function formatSegment(
  msgs: SegmentMessage[],
  characterName: string,
  chatDate: string,
  idx: number,
  total: number,
): string {
  const lines = [
    `[Character: ${characterName} | Chat: ${chatDate} | Segment ${idx + 1}/${total}]`,
    "",
  ];
  for (const m of msgs) {
    const c = cleanText(m.content);
    if (c) lines.push(`${m.speaker}: ${c}`);
  }
  return lines.join("\n");
}

export function segmentChat(
  input: SegmentMessage[],
  opts: { characterName: string; chatDate: string },
): Segment[] {
  // Drop empty messages (callers pass non-system msgs); skip greeting-only conversations.
  const msgs = input
    .filter((m) => m.content.trim().length > 0)
    .map((m) =>
      m.content.length > TARGET_TOKENS * 4
        ? { ...m, content: m.content.slice(0, TARGET_TOKENS * 4) }
        : m,
    );
  if (msgs.length === 0 || !msgs.some((m) => m.isUser)) return [];

  const sizes = msgs.map((m) => approxTokens(m.content));
  const total = sizes.reduce((a, b) => a + b, 0);

  const ranges: [number, number][] = [];
  if (total <= TARGET_TOKENS) {
    ranges.push([0, msgs.length - 1]);
  } else {
    let start = 0;
    while (start < msgs.length) {
      let acc = 0;
      let end = start;
      while (end < msgs.length && acc < TARGET_TOKENS) {
        acc += sizes[end] ?? 0;
        end += 1;
      }
      end -= 1; // inclusive last
      while (end > start && !isPairBoundary(msgs, end)) end -= 1;
      ranges.push([start, end]);

      const advance = Math.max(1, Math.floor((end - start + 1) * OVERLAP_RATIO));
      let nextStart = start + advance;
      while (nextStart < msgs.length - 1 && !isPairBoundary(msgs, nextStart - 1)) nextStart += 1;
      if (nextStart >= msgs.length) break;
      start = nextStart;
    }
    // Fold a too-small trailing remainder into the last segment (else its own segment).
    const last = ranges[ranges.length - 1];
    if (last && last[1] < msgs.length - 1) {
      const trailingStart = last[1] + 1;
      let trailingSize = 0;
      for (let i = trailingStart; i < msgs.length; i += 1) trailingSize += sizes[i] ?? 0;
      if (trailingSize >= MIN_TOKENS) ranges.push([trailingStart, msgs.length - 1]);
      else ranges[ranges.length - 1] = [last[0], msgs.length - 1];
    }
  }

  return ranges.map(([s, e], i) => {
    const segMsgs = msgs.slice(s, e + 1);
    const speakers = [...new Set(segMsgs.map((m) => m.speaker))].sort();
    return {
      index: i,
      total: ranges.length,
      msgStart: s,
      msgEnd: e,
      text: formatSegment(segMsgs, opts.characterName, opts.chatDate, i, ranges.length),
      firstDate: segMsgs[0]?.sendDate ?? null,
      lastDate: segMsgs[segMsgs.length - 1]?.sendDate ?? null,
      speakers,
    };
  });
}
