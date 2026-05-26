import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db, runMigrations } from "../../../db/client";
import {
  characters,
  characterVersions,
  chatEvents,
  chats,
  messages,
  messageVariants,
  presets,
  presetVersions,
  users,
} from "../../../db/schema";
import type { ChatTurnResult } from "../../providers/turn";
import { createChatService } from "./service";

// Swipe persistence/provenance, with an INJECTED fake runner (no real model — tests/AGENTS.md:
// mock only the provider boundary; the DB is real in-memory libSQL).
let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
  await runMigrations(db);
});

// A second-generation turn result the fake runner returns for the swipe.
function fakeTurn(): ChatTurnResult {
  return {
    reply: "second gen",
    sessionId: "",
    stopReason: "end_turn",
    terminalReason: "completed",
    finishReason: "stop",
    ttftMs: 100,
    apiErrorStatus: null,
    numTurns: 1,
    usage: {
      model: "claude-sonnet-4-6",
      tokensIn: 150,
      tokensOut: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      contextWindow: 200000,
      maxOutputTokens: 32000,
      costUsd: 0.0005,
    },
    events: [],
    rateLimit: null,
  };
}

async function seed(): Promise<void> {
  const now = Date.now();
  await db.insert(users).values({ id: "u1", handle: "u1", createdAt: now });
  await db.insert(characters).values({ id: "c1", ownerId: "u1", handle: "probe", createdAt: now });
  await db.insert(characterVersions).values({
    id: "v1",
    characterId: "c1",
    version: 1,
    name: "Probe",
    description: "test",
    createdAt: now,
  });
  await db.update(characters).set({ currentVersionId: "v1" }).where(eq(characters.id, "c1"));
  await db.insert(chats).values({
    id: "ch1",
    ownerId: "u1",
    title: "t",
    characterVersionId: "v1",
    sessionId: "sess-1",
    messageCount: 2,
    totalTokensIn: 200,
    totalTokensOut: 10,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values([
    { id: "m1", chatId: "ch1", seq: 1, role: "user", content: "hi", createdAt: now },
    {
      id: "m2",
      chatId: "ch1",
      seq: 2,
      role: "assistant",
      content: "first gen",
      model: "claude-opus-4-7",
      provider: "agent-sdk/max-pro-sub",
      tokensIn: 200,
      tokensOut: 10,
      contextWindow: 200000,
      costUsd: 0.002,
      createdAt: now,
    },
  ]);
}

describe("swipe provenance", () => {
  test("backfills variant 0 with first-gen tokens, stamps the active row with the new gen, counts swipe tokens", async () => {
    const svc = createChatService(db, { runTurn: async () => fakeTurn() });
    await seed();

    const result = await svc.swipe({ username: "u1", chatId: "ch1", expectedSeq: 2 });
    expect(result.status).toBe("ok");

    // The message row now describes the ACTIVE (new) variant in content AND provenance.
    const tip = (await db.select().from(messages).where(eq(messages.id, "m2")))[0];
    expect(tip?.content).toBe("second gen");
    expect(tip?.activeVariantIdx).toBe(1);
    expect(tip?.tokensIn).toBe(150);
    expect(tip?.tokensOut).toBe(8);
    expect(tip?.model).toBe("claude-sonnet-4-6");
    expect(tip?.costUsd).toBeCloseTo(0.0005);

    // Variant 0 preserved the FIRST generation's tokens (not null); variant 1 is the new gen.
    const variants = await db
      .select()
      .from(messageVariants)
      .where(eq(messageVariants.messageId, "m2"))
      .orderBy(asc(messageVariants.idx));
    expect(variants.map((v) => [v.idx, v.content, v.tokensOut])).toEqual([
      [0, "first gen", 10],
      [1, "second gen", 8],
    ]);

    // The swipe's tokens were added to the chat totals (200+150, 10+8).
    const chat = (await db.select().from(chats).where(eq(chats.id, "ch1")))[0];
    expect(chat?.totalTokensIn).toBe(350);
    expect(chat?.totalTokensOut).toBe(18);
    expect(chat?.messageCount).toBe(2); // swipe mutates the tip — no new message
  });

  test("selectVariant reverts the row's tokens/model to match the chosen variant", async () => {
    const svc = createChatService(db, { runTurn: async () => fakeTurn() });
    await seed();
    await svc.swipe({ username: "u1", chatId: "ch1", expectedSeq: 2 });

    await svc.selectVariant({ username: "u1", chatId: "ch1", messageId: "m2", variantIdx: 0 });

    const tip = (await db.select().from(messages).where(eq(messages.id, "m2")))[0];
    expect(tip?.content).toBe("first gen");
    expect(tip?.tokensIn).toBe(200);
    expect(tip?.tokensOut).toBe(10);
    expect(tip?.model).toBe("claude-opus-4-7");
  });

  test("a turn's structured events are persisted to chat_events (linked to the message)", async () => {
    const turnWithEvent: ChatTurnResult = {
      ...fakeTurn(),
      events: [
        {
          kind: "compaction",
          at: 1_700_000_000_000,
          trigger: "auto",
          preTokens: 100_000,
          postTokens: 40_000,
          durationMs: 6_000,
          preserved: false,
        },
      ],
    };
    const svc = createChatService(db, { runTurn: async () => turnWithEvent });
    await seed();

    await svc.swipe({ username: "u1", chatId: "ch1", expectedSeq: 2 });

    const events = await db.select().from(chatEvents).where(eq(chatEvents.chatId, "ch1"));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("compaction");
    expect(events[0]?.messageId).toBe("m2");
    expect(events[0]?.at).toBe(1_700_000_000_000);
  });
});

describe("manual compaction", () => {
  test("compact() runs a /compact turn on an agent-sdk chat and records the compaction event", async () => {
    const compactTurn: ChatTurnResult = {
      ...fakeTurn(),
      reply: "",
      events: [
        {
          kind: "compaction",
          at: 1_700_000_000_000,
          trigger: "manual",
          preTokens: 120_000,
          postTokens: 30_000,
          durationMs: 8_000,
          preserved: false,
        },
      ],
    };
    let sawPrompt = "";
    const svc = createChatService(db, {
      runTurn: async (p) => {
        sawPrompt = p.prompt;
        return compactTurn;
      },
    });
    await seed(); // ch1 is agent-sdk with sessionId "sess-1"

    const result = await svc.compact({ username: "u1", chatId: "ch1" });

    expect(result.compacted).toBe(true);
    expect(sawPrompt.startsWith("/compact ")).toBe(true); // steered compaction prompt
    const events = await db.select().from(chatEvents).where(eq(chatEvents.chatId, "ch1"));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("compaction");
    expect(events[0]?.messageId).toBeNull(); // compaction isn't tied to a message
    // no message row was added (compaction doesn't generate)
    const msgs = await db.select().from(messages).where(eq(messages.chatId, "ch1"));
    expect(msgs).toHaveLength(2);
  });

  test("managed mode auto-fires /compact after a send once context-fill crosses the threshold", async () => {
    const now = Date.now();
    // A turn that reports a nearly-full context (180k / 200k = 0.9) so managed compaction triggers.
    const fullTurn: ChatTurnResult = {
      ...fakeTurn(),
      usage: { ...fakeTurn().usage, tokensIn: 180_000, contextWindow: 200_000 },
    };
    const prompts: string[] = [];
    const svc = createChatService(db, {
      runTurn: async (p) => {
        prompts.push(p.prompt);
        return fullTurn;
      },
    });
    await seed(); // ch1: agent-sdk, sessionId sess-1, tip at seq 2

    // Pin a preset with compaction managed @ 50% so the 0.9 fill trips it.
    await db
      .insert(presets)
      .values({ id: "p1", ownerId: "u1", name: "x", kind: "x", createdAt: now, updatedAt: now });
    await db.insert(presetVersions).values({
      id: "pv1",
      presetId: "p1",
      version: 1,
      schemaVersion: 1,
      config: {
        schemaVersion: 1,
        sections: [],
        params: { compaction: { mode: "managed", thresholdPct: 0.5 } },
      },
      createdAt: now,
    });
    await db.update(chats).set({ presetVersionId: "pv1" }).where(eq(chats.id, "ch1"));

    const result = await svc.send({
      username: "u1",
      chatId: "ch1",
      expectedSeq: 2,
      content: "hello",
    });

    expect(result.status).toBe("ok");
    // Two runTurn calls: the user turn, then the auto-fired /compact.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe("hello");
    expect(prompts[1]?.startsWith("/compact ")).toBe(true);
  });

  test("compact() is a no-op for a chat with no session yet", async () => {
    const svc = createChatService(db, { runTurn: async () => fakeTurn() });
    await db.insert(users).values({ id: "u1", handle: "u1", createdAt: Date.now() });
    await db
      .insert(characters)
      .values({ id: "c1", ownerId: "u1", handle: "p", createdAt: Date.now() });
    await db.insert(characterVersions).values({
      id: "v1",
      characterId: "c1",
      version: 1,
      name: "P",
      description: "d",
      createdAt: Date.now(),
    });
    await db.update(characters).set({ currentVersionId: "v1" }).where(eq(characters.id, "c1"));
    await db.insert(chats).values({
      id: "ch2",
      ownerId: "u1",
      title: "t",
      characterVersionId: "v1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }); // no sessionId

    expect(await svc.compact({ username: "u1", chatId: "ch2" })).toEqual({ compacted: false });
  });
});
