import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db, runMigrations } from "../../../db/client";
import {
  characters,
  characterVersions,
  chats,
  messages,
  messageVariants,
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
});
