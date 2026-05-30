import { describe, expect, test } from "vitest";
import { enforceRateLimit } from "./rate-limit";

// The limiters are module-level + stateful, so each test uses a unique key to get an independent bucket.
describe("enforceRateLimit", () => {
  test("allows requests under the limit", async () => {
    await expect(
      enforceRateLimit({ path: "chat.list", key: "under-limit" }),
    ).resolves.toBeUndefined();
  });

  test("throws TOO_MANY_REQUESTS past the general mutation limit (120)", async () => {
    const key = "general-flood";
    for (let i = 0; i < 120; i++) {
      await enforceRateLimit({ path: "preset.update", key });
    }
    await expect(enforceRateLimit({ path: "preset.update", key })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  test("the AI-turn bucket is stricter (30) for send/swipe/start", async () => {
    const key = "ai-flood";
    for (let i = 0; i < 30; i++) {
      await enforceRateLimit({ path: "chat.send", key });
    }
    // General bucket still has headroom; the ai-turn bucket is now empty → rejected.
    await expect(enforceRateLimit({ path: "chat.send", key })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  test("a non-turn verb is NOT charged to the AI bucket", async () => {
    const key = "ai-untouched";
    for (let i = 0; i < 40; i++) {
      await enforceRateLimit({ path: "chat.updateTitle", key });
    }
    // 40 general consumed but the ai bucket is untouched → a turn still works.
    await expect(enforceRateLimit({ path: "chat.send", key })).resolves.toBeUndefined();
  });
});
