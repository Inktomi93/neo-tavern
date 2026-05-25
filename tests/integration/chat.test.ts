import { expect, test } from "vitest";
import { ChatNotFoundError, createChatService } from "../../src/server/domain/chat";
import type { ChatTurnParams, ChatTurnResult } from "../../src/server/providers/claude-sdk";
import { freshDb } from "../support/db";

// A fake SDK runner — records calls, returns a canned turn. Keeps the turn LOGIC
// testable without a real sub query (those live in scripts/sdk-contract).
function fakeRunner(reply: string) {
  const calls: ChatTurnParams[] = [];
  const run = (params: ChatTurnParams): Promise<ChatTurnResult> => {
    calls.push(params);
    return Promise.resolve({
      reply,
      sessionId: "sess-1",
      stopReason: "end_turn",
      usage: {
        model: "fake",
        tokensIn: 10,
        tokensOut: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.001,
      },
    });
  };
  return { run, calls };
}

const baseChar = { characterName: "Aria", characterDescription: "a test character" };

test("create → send round-trips two messages with correct seq + roles", async () => {
  const db = await freshDb();
  const { run, calls } = fakeRunner("hi from the fake model");
  const chat = createChatService(db, { runTurn: run });

  const { chatId } = await chat.create({ username: "owner", title: "T", ...baseChar });
  const result = await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hello" });

  expect(result.status).toBe("ok");
  expect(result.messages).toHaveLength(2);
  expect(result.messages[0]?.role).toBe("user");
  expect(result.messages[0]?.seq).toBe(1);
  expect(result.messages[0]?.content).toBe("hello");
  expect(result.messages[1]?.role).toBe("assistant");
  expect(result.messages[1]?.seq).toBe(2);
  expect(result.messages[1]?.content).toBe("hi from the fake model");
  expect(calls[0]?.resume).toBeUndefined(); // first turn → no resume
});

test("stale send (wrong expectedSeq) returns 'stale' and does NOT run the model", async () => {
  const db = await freshDb();
  const { run, calls } = fakeRunner("x");
  const chat = createChatService(db, { runTurn: run });

  const { chatId } = await chat.create({ username: "owner", title: "T", ...baseChar });
  await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "first" }); // tip now at seq 2

  const stale = await chat.send({
    username: "owner",
    chatId,
    expectedSeq: 0,
    content: "stale draft",
  });

  expect(stale.status).toBe("stale");
  expect(calls).toHaveLength(1); // the stale send never reached the model
});

test("the next turn resumes the persisted session id", async () => {
  const db = await freshDb();
  const { run, calls } = fakeRunner("ok");
  const chat = createChatService(db, { runTurn: run });

  const { chatId } = await chat.create({ username: "owner", title: "T", ...baseChar });
  await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "one" });
  await chat.send({ username: "owner", chatId, expectedSeq: 2, content: "two" });

  expect(calls[1]?.resume).toBe("sess-1"); // session id from turn 1 was stored + resumed
});

test("a chat owned by another user is NOT_FOUND-scoped", async () => {
  const db = await freshDb();
  const { run } = fakeRunner("x");
  const chat = createChatService(db, { runTurn: run });

  const { chatId } = await chat.create({ username: "owner", title: "T", ...baseChar });

  await expect(chat.listMessages({ username: "intruder", chatId })).rejects.toBeInstanceOf(
    ChatNotFoundError,
  );
});
