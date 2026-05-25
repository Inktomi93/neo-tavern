import { expect, test } from "vitest";
import {
  buildCardEmbedText,
  type SegmentMessage,
  segmentChat,
} from "../../src/server/domain/corpus";

// ── Card embedding text ──────────────────────────────────────────────────────
test("buildCardEmbedText: name first, placeholders normalized, HTML stripped, empties skipped", () => {
  const text = buildCardEmbedText({
    name: "Aria",
    description: "<b>{{char}}</b> greets {{user}} warmly.",
    personality: null, // skipped
    scenario: "A tavern.",
    firstMessage: null,
    exampleMessages: null,
    creatorNotes: null,
    systemPrompt: null,
    postHistoryInstructions: null,
    alternateGreetings: ["Hello again, {{user}}."],
    tags: ["fantasy", "tavern"],
  });
  expect(text.startsWith("Name: Aria")).toBe(true);
  expect(text).toContain("Tags: fantasy, tavern");
  expect(text).toContain("Description: Aria greets User warmly."); // {{char}}/{{user}} + HTML cleaned
  expect(text).toContain("Scenario: A tavern.");
  expect(text).not.toContain("Personality"); // null field omitted
  expect(text).toContain("Alternate Greetings:\nHello again, User.");
});

// ── Segmentation ──────────────────────────────────────────────────────────────
function convo(n: number, charsEach: number): SegmentMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    isUser: i % 2 === 0,
    speaker: i % 2 === 0 ? "User" : "Aria",
    content: (i % 2 === 0 ? "U" : "A").repeat(charsEach),
    sendDate: 1000 + i,
  }));
}

test("short chat → a single segment covering all messages", () => {
  const segs = segmentChat(convo(4, 100), { characterName: "Aria", chatDate: "2026-01-01" });
  expect(segs).toHaveLength(1);
  expect(segs[0]?.msgStart).toBe(0);
  expect(segs[0]?.msgEnd).toBe(3);
  expect(segs[0]?.text).toContain("[Character: Aria | Chat: 2026-01-01 | Segment 1/1]");
  expect(segs[0]?.speakers).toEqual(["Aria", "User"]);
});

test("greeting-only (no user message) → no segments", () => {
  const greetingOnly: SegmentMessage[] = [
    { isUser: false, speaker: "Aria", content: "Hi there.", sendDate: 1 },
  ];
  expect(segmentChat(greetingOnly, { characterName: "Aria", chatDate: "d" })).toEqual([]);
});

test("long chat → multiple overlapping segments, none orphaning a user→char pair", () => {
  // 24 msgs × 800 chars (~200 tok) ≈ 4800 tok over a 2000 target → several segments.
  const segs = segmentChat(convo(24, 800), { characterName: "Aria", chatDate: "d" });
  expect(segs.length).toBeGreaterThan(1);

  const msgs = convo(24, 800);
  for (const s of segs) {
    // a segment must end after a character msg, or at the very last message
    const endsOnChar = !msgs[s.msgEnd]?.isUser;
    const isLastMsg = s.msgEnd === msgs.length - 1;
    expect(endsOnChar || isLastMsg).toBe(true);
  }
  // overlap: the second segment starts at or before the first's end
  expect(segs[1]?.msgStart ?? Infinity).toBeLessThanOrEqual(segs[0]?.msgEnd ?? -1);
  // full coverage to the end
  expect(segs[segs.length - 1]?.msgEnd).toBe(23);
});

test("oversized single message is truncated, not dropped", () => {
  const huge = "x".repeat(2000 * 4 + 5000); // well over the 2000-token target
  const segs = segmentChat(
    [
      { isUser: true, speaker: "User", content: "tell me a lot", sendDate: 1 },
      { isUser: false, speaker: "Aria", content: huge, sendDate: 2 },
    ],
    { characterName: "Aria", chatDate: "d" },
  );
  expect(segs.length).toBeGreaterThanOrEqual(1);
  // the giant message was clipped to ~target*4 chars, so the segment text isn't enormous
  expect(segs[0]?.text.length ?? 0).toBeLessThan(2000 * 4 + 500);
});
