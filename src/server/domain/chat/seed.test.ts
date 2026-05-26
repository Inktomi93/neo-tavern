import { expect, test } from "vitest";
import { buildSeedFrames, type SeedTurn } from "./seed";

// Pure shape test — the EMPIRICAL "does it actually resume" validation lives in
// scripts/seed-probe.ts (it costs a real sub query). This locks the structural invariants the
// probe proved load-bearing: per-frame sessionId, a parentUuid chain, valid uuids, one frame/turn.

const SESSION = "11111111-2222-4333-8444-555555555555";

// Frames are opaque SessionStoreEntry; view the fields we assert through a named shape so dot
// access satisfies both tsc (noPropertyAccessFromIndexSignature) and Biome (useLiteralKeys).
interface FrameView {
  type: string;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  message: { model: string };
}

function frame(frames: ReturnType<typeof buildSeedFrames>, i: number): FrameView {
  return frames[i] as unknown as FrameView;
}

test("builds one frame per canon turn, role-matched", () => {
  const canon: SeedTurn[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", model: "claude-x" },
  ];

  const frames = buildSeedFrames(canon, SESSION);

  expect(frames).toHaveLength(2);
  expect(frame(frames, 0).type).toBe("user");
  expect(frame(frames, 1).type).toBe("assistant");
});

test("every frame carries the resume sessionId (the load-bearing field)", () => {
  const frames = buildSeedFrames([{ role: "user", content: "x" }], SESSION);

  expect(frame(frames, 0).sessionId).toBe(SESSION);
});

test("frames form a parentUuid chain rooted at null", () => {
  const frames = buildSeedFrames(
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ],
    SESSION,
  );

  expect(frame(frames, 0).parentUuid).toBeNull(); // root
  expect(frame(frames, 1).parentUuid).toBe(frame(frames, 0).uuid);
  expect(frame(frames, 2).parentUuid).toBe(frame(frames, 1).uuid);
  // uuids are distinct + present
  const uuids = frames.map((_, i) => frame(frames, i).uuid);
  expect(new Set(uuids).size).toBe(3);
});

test("assistant frames carry a model (provenance), falling back to the sdk default", () => {
  const frames = buildSeedFrames([{ role: "assistant", content: "x" }], SESSION);
  const { message } = frame(frames, 0);

  expect(typeof message.model).toBe("string");
  expect(message.model.length).toBeGreaterThan(0);
});
