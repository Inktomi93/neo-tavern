import { expect, test } from "vitest";
import { parseChatJsonl, parseStDate } from "../../src/server/domain/corpus/import/chat";

// Synthetic JSONL fixtures (one header line + message lines) — deliberately encode the
// edge cases a single real chat won't have all at once: swipes, mes≠active-swipe, short
// swipe_info, the 4 buckets, every date format, and both branch-filename patterns.
function jsonl(header: object, ...messages: object[]): string {
  return [header, ...messages].map((o) => JSON.stringify(o)).join("\n");
}
const opts = { fileName: "Cheese - 2026-01-08@11h12m17s008ms.jsonl", charDirName: "Cheese" };

test("date parser handles ISO, ST @-format, human, epoch number, and epoch string", () => {
  expect(parseStDate("2025-12-15T06:39:01.664Z")).toBe(Date.parse("2025-12-15T06:39:01.664Z"));
  expect(parseStDate("2025-07-03@14h56m48s989ms")).toBe(new Date(2025, 6, 3, 14, 56, 48).getTime());
  expect(parseStDate("August 27, 2025 6:36pm")).toBe(new Date(2025, 7, 27, 18, 36).getTime());
  expect(parseStDate(1776108861642)).toBe(1776108861642); // epoch ms (number)
  expect(parseStDate("1776108861642")).toBe(1776108861642); // epoch ms (string) — st-bridge fix
  expect(parseStDate("")).toBeNull();
  expect(parseStDate(null)).toBeNull();
  expect(parseStDate("2025")).toBeNull(); // not a 10+ digit epoch — don't misread a bare year
});

test("header character_name 'unused' falls back to the directory name", () => {
  const c = parseChatJsonl(
    jsonl(
      { user_name: "Nate", character_name: "unused" },
      { name: "x", is_user: false, mes: "hi" },
    ),
    opts,
  );
  expect(c?.characterName).toBe("Cheese");
  expect(c?.userName).toBe("Nate");
});

test("maps roles and parses send_date", () => {
  const c = parseChatJsonl(
    jsonl(
      { character_name: "Cheese" },
      { is_user: false, mes: "greeting", send_date: "2025-12-15T06:39:01.664Z" },
      { is_user: true, mes: "hello there" },
      { is_system: true, mes: "Generation stopped" },
    ),
    opts,
  );
  expect(c?.messages.map((m) => m.role)).toEqual(["assistant", "user", "system"]);
  expect(c?.messages[0]?.sendDate).toBe(Date.parse("2025-12-15T06:39:01.664Z"));
  expect(c?.bucket).toBe("real_conversation");
});

test("swipes → variants; content = mes (the rendered text), activeVariantIdx = swipe_id", () => {
  const c = parseChatJsonl(
    jsonl(
      { character_name: "Cheese" },
      {
        is_user: false,
        mes: "EDITED active text", // diverges from swipes[1] — content must be `mes`
        swipes: ["gen zero", "gen one", "gen two"],
        swipe_id: 1,
        swipe_info: [
          {
            extra: { model: "opus", api: "anthropic" },
            gen_started: "2025-12-15T06:00:00.000Z",
            gen_finished: "2025-12-15T06:00:02.000Z",
          },
          { extra: { model: "sonnet", api: "anthropic" } },
          // deliberately shorter than swipes (real data: 104 cases) — third swipe has no info
        ],
      },
    ),
    opts,
  );
  const m = c?.messages[0];
  expect(m?.content).toBe("EDITED active text");
  expect(m?.activeVariantIdx).toBe(1);
  expect(m?.variants).toHaveLength(3);
  expect(m?.variants[0]?.model).toBe("opus");
  expect(m?.variants[0]?.genFinished).toBe(Date.parse("2025-12-15T06:00:02.000Z"));
  expect(m?.variants[1]?.model).toBe("sonnet");
  expect(m?.variants[2]?.model).toBeNull(); // swipe_info ran out → nulls, not a crash
});

test("single generation → no variants; out-of-range swipe_id → activeVariantIdx null", () => {
  const single = parseChatJsonl(
    jsonl(
      { character_name: "C" },
      { is_user: false, mes: "only one", swipes: ["only one"], swipe_id: 0 },
    ),
    opts,
  );
  expect(single?.messages[0]?.variants).toHaveLength(0);
  expect(single?.messages[0]?.activeVariantIdx).toBeNull();

  const oob = parseChatJsonl(
    jsonl({ character_name: "C" }, { is_user: false, mes: "m", swipes: ["a", "b"], swipe_id: 9 }),
    opts,
  );
  expect(oob?.messages[0]?.variants).toHaveLength(2);
  expect(oob?.messages[0]?.activeVariantIdx).toBeNull();
});

test("4-bucket classification", () => {
  expect(parseChatJsonl(jsonl({ character_name: "C" }), opts)?.bucket).toBe("header_only");
  expect(
    parseChatJsonl(
      jsonl(
        { character_name: "C" },
        { is_system: true, mes: "sys" },
        { is_user: false, mes: "   " },
      ),
      opts,
    )?.bucket,
  ).toBe("all_empty_msgs");
  expect(
    parseChatJsonl(jsonl({ character_name: "C" }, { is_user: false, mes: "just a greeting" }), opts)
      ?.bucket,
  ).toBe("greeting_only");
});

test("branch detection (both filename patterns) + parent ref resolution", () => {
  // Pattern A: "CharName - date - Branch #N.jsonl" — startsWith("Branch") would MISS this.
  const a = parseChatJsonl(jsonl({ character_name: "C" }, { is_user: false, mes: "x" }), {
    fileName: "Azarael - 2026-05-09@18h48m32s372ms - Branch #2.jsonl",
    charDirName: "Azarael",
  });
  expect(a?.isBranch).toBe(true);
  // no main_chat → derived from filename
  expect(a?.parentRef).toBe("Azarael - 2026-05-09@18h48m32s372ms.jsonl");

  // main_chat present → authoritative, +.jsonl appended
  const b = parseChatJsonl(
    jsonl(
      { character_name: "C", chat_metadata: { main_chat: "Azarael - 2026-05-01@10h00m00s000ms" } },
      { is_user: false, mes: "x" },
    ),
    { fileName: "Branch #1 - 2026-05-09.jsonl", charDirName: "Azarael" },
  );
  expect(b?.isBranch).toBe(true);
  expect(b?.parentRef).toBe("Azarael - 2026-05-01@10h00m00s000ms.jsonl");

  // non-branch → not a branch, no parent
  const c = parseChatJsonl(jsonl({ character_name: "C" }, { is_user: false, mes: "x" }), opts);
  expect(c?.isBranch).toBe(false);
  expect(c?.parentRef).toBeNull();
});

test("returns null only on an unparseable header; skips corrupt message lines", () => {
  expect(parseChatJsonl("{not json", opts)).toBeNull();
  const c = parseChatJsonl(
    `${JSON.stringify({ character_name: "C" })}\n{bad line\n${JSON.stringify({ is_user: true, mes: "kept" })}`,
    opts,
  );
  expect(c?.messages).toHaveLength(1);
  expect(c?.messages[0]?.content).toBe("kept");
});
