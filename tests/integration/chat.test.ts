import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { chats, messages, sessionEntries } from "../../src/db/schema";
import { ChatNotFoundError, createChatService } from "../../src/server/domain/chat";
import type { ChatTurnParams } from "../../src/server/providers/claude-sdk";
import type { RawTurnParams } from "../../src/server/providers/openrouter";
import { type ChatTurnResult, TurnError } from "../../src/server/providers/turn";
import { freshDb, seedCharacter, seedChatRow } from "../support/db";

function cannedTurn(reply: string): ChatTurnResult {
  return {
    reply,
    sessionId: "sess-1",
    stopReason: "end_turn",
    terminalReason: "completed",
    finishReason: "stop",
    ttftMs: 200,
    durationApiMs: null,
    apiErrorStatus: null,
    numTurns: 1,
    usage: {
      model: "fake",
      tokensIn: 10,
      tokensOut: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      reasoningTokens: null,
      contextWindow: 200000,
      maxOutputTokens: 8192,
      webSearchRequests: 0,
      costUsd: 0.001,
      costDetails: null,
      isByok: null,
    },
    events: [],
    rateLimit: null,
  };
}

// A fake SDK runner — records calls, returns a canned turn. Keeps the turn LOGIC
// testable without a real sub query (those live in scripts/sdk-contract).
function fakeRunner(reply: string) {
  const calls: ChatTurnParams[] = [];
  const run = (params: ChatTurnParams): Promise<ChatTurnResult> => {
    calls.push(params);
    return Promise.resolve(cannedTurn(reply));
  };
  return { run, calls };
}

// A fake runner that fails the turn with a typed provider error.
function failingRunner(error: TurnError) {
  const calls: ChatTurnParams[] = [];
  const run = (params: ChatTurnParams): Promise<ChatTurnResult> => {
    calls.push(params);
    return Promise.reject(error);
  };
  return { run, calls };
}

// A fake runner that returns a different reply each call — so swipe variants are distinguishable.
function seqRunner(replies: string[]) {
  const calls: ChatTurnParams[] = [];
  let i = 0;
  const run = (params: ChatTurnParams): Promise<ChatTurnResult> => {
    calls.push(params);
    const reply = replies[Math.min(i, replies.length - 1)] ?? "x";
    i += 1;
    return Promise.resolve(cannedTurn(reply));
  };
  return { run, calls };
}

// Raw-mode turn result: no SDK session (sessionId ""), usage.model echoes the routed model.
function cannedRawTurn(reply: string, model: string): ChatTurnResult {
  return { ...cannedTurn(reply), sessionId: "", usage: { ...cannedTurn(reply).usage, model } };
}

function fakeRawRunner(reply: string) {
  const calls: RawTurnParams[] = [];
  const run = (params: RawTurnParams): Promise<ChatTurnResult> => {
    calls.push(params);
    return Promise.resolve(cannedRawTurn(reply, params.model));
  };
  return { run, calls };
}

function failingRawRunner(error: TurnError) {
  const calls: RawTurnParams[] = [];
  const run = (params: RawTurnParams): Promise<ChatTurnResult> => {
    calls.push(params);
    return Promise.reject(error);
  };
  return { run, calls };
}

// Flip a freshly-created (agent-sdk) chat onto the openrouter Responses runner with a pinned model
// — the shape setProvider produces. (create() only makes agent-sdk chats.)
async function makeRaw(
  db: Awaited<ReturnType<typeof freshDb>>,
  chatId: string,
  model: string,
): Promise<void> {
  await db
    .update(chats)
    .set({ api: "responses", source: "openrouter", model })
    .where(eq(chats.id, chatId));
}

test("create → send round-trips two messages with correct seq + roles", async () => {
  const db = await freshDb();
  const { run, calls } = fakeRunner("hi from the fake model");
  const chat = createChatService(db, { runTurn: run });

  const { chatId } = await seedChatRow(db);
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

  const { chatId } = await seedChatRow(db);
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

  const { chatId } = await seedChatRow(db);
  await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "one" });
  await chat.send({ username: "owner", chatId, expectedSeq: 2, content: "two" });

  expect(calls[1]?.resume).toBe("sess-1"); // session id from turn 1 was stored + resumed
});

test("a chat owned by another user is NOT_FOUND-scoped", async () => {
  const db = await freshDb();
  const { run } = fakeRunner("x");
  const chat = createChatService(db, { runTurn: run });

  const { chatId } = await seedChatRow(db);

  await expect(chat.listMessages({ username: "intruder", chatId })).rejects.toBeInstanceOf(
    ChatNotFoundError,
  );
});

test("a failed turn rolls the user message back out and returns a typed error", async () => {
  const db = await freshDb();
  const resetsAt = Date.now() + 60_000;
  const { run } = failingRunner(
    new TurnError({
      kind: "rate_limit",
      retryable: true,
      message: "rate limited",
      resetsAt,
    }),
  );
  const chat = createChatService(db, { runTurn: run });

  const { chatId } = await seedChatRow(db);
  const result = await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hello" });

  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.code).toBe("rate_limit");
    expect(result.retryable).toBe(true);
    expect(result.resetsAt).toBe(resetsAt);
  }
  // Atomic send: the user message was rolled back, so the chat is at its prior empty tip —
  // re-sending with the same expectedSeq must work (the rollback didn't advance seq).
  expect(result.messages).toHaveLength(0);
  const retry = await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hello" });
  expect(retry.status).not.toBe("stale"); // the rollback restored the tip → expectedSeq 0 is still valid
});

test("a raw-mode chat generates through runRaw with provider=openrouter and no session id", async () => {
  const db = await freshDb();
  const sdk = fakeRunner("sdk reply");
  const raw = fakeRawRunner("raw reply");
  const chat = createChatService(db, { runTurn: sdk.run, runRaw: raw.run });

  const { chatId } = await seedChatRow(db);
  await makeRaw(db, chatId, "deepseek/deepseek-chat");

  const result = await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hello" });

  // The raw runner ran (not the sdk one), with the routed model + the canon history.
  expect(sdk.calls).toHaveLength(0);
  expect(raw.calls).toHaveLength(1);
  expect(raw.calls[0]?.model).toBe("deepseek/deepseek-chat");
  expect(raw.calls[0]?.history).toEqual([{ role: "user", content: "hello" }]);

  expect(result.status).toBe("ok");
  expect(result.messages.at(-1)?.content).toBe("raw reply");

  // Provenance is the api/source that ran: the assistant row records responses/openrouter + the model.
  const assistant = (await db.select().from(messages).where(eq(messages.chatId, chatId))).find(
    (m) => m.role === "assistant",
  );
  expect(assistant?.provider).toBe("responses/openrouter");
  expect(assistant?.model).toBe("deepseek/deepseek-chat");

  // sdk-only concept — a raw turn must not stamp a session id.
  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  expect(row?.sessionId).toBeNull();
});

test("a failed raw turn rolls back identically to sdk (shared error path)", async () => {
  const db = await freshDb();
  const raw = failingRawRunner(
    new TurnError({ kind: "billing", retryable: false, message: "out of credits" }),
  );
  const chat = createChatService(db, { runRaw: raw.run });

  const { chatId } = await seedChatRow(db);
  await makeRaw(db, chatId, "deepseek/deepseek-chat");

  const result = await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hello" });

  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.code).toBe("billing");
    expect(result.retryable).toBe(false);
  }
  expect(result.messages).toHaveLength(0); // user message rolled back
});

// ── 5D: conversion + fork-and-convert ────────────────────────────────────────

test("setProvider switches an agent-sdk chat onto the openrouter Responses runner; next turn routes through runRaw", async () => {
  const db = await freshDb();
  const sdk = fakeRunner("sdk reply");
  const raw = fakeRawRunner("raw reply");
  const chat = createChatService(db, { runTurn: sdk.run, runRaw: raw.run });

  const { chatId } = await seedChatRow(db);
  await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hi" }); // agent-sdk turn, sets sessionId

  await chat.setProvider({ username: "owner", chatId, api: "responses", source: "openrouter" });

  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  expect(row?.api).toBe("responses");
  expect(row?.source).toBe("openrouter");
  expect(row?.model).toBeNull(); // no model picked → resolver default
  expect(row?.sessionId).toBeNull(); // leaving agent-sdk drops the session
  expect(row?.convertedAt).not.toBeNull();

  // The next turn now routes through the openrouter runner (canon rebuilt from the existing messages).
  await chat.send({ username: "owner", chatId, expectedSeq: 2, content: "again" });
  expect(raw.calls).toHaveLength(1);
  expect(sdk.calls).toHaveLength(1); // only the pre-switch turn
});

test("setProvider to chat-completions routes the next turn through the chat-completions runner", async () => {
  const db = await freshDb();
  const sdk = fakeRunner("sdk reply");
  const chatCompletion = fakeRawRunner("chat-completions reply");
  const responses = fakeRawRunner("responses reply");
  const chat = createChatService(db, {
    runTurn: sdk.run,
    runRaw: responses.run,
    runChatCompletion: chatCompletion.run,
  });
  const { chatId } = await seedChatRow(db);

  await chat.setProvider({
    username: "owner",
    chatId,
    api: "chat-completions",
    source: "openrouter",
  });
  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  expect(row?.api).toBe("chat-completions");

  const result = await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hi" });
  expect(result.status).toBe("ok");
  expect(chatCompletion.calls).toHaveLength(1); // chat.send, not beta.responses
  expect(responses.calls).toHaveLength(0);
  expect(result.messages.at(-1)?.content).toBe("chat-completions reply");
});

test("setProvider to an incoherent combo (chat-completions + max-pro-sub) throws invalid_provider", async () => {
  const db = await freshDb();
  const chat = createChatService(db, {
    runTurn: fakeRunner("x").run,
    runRaw: fakeRawRunner("y").run,
  });
  const { chatId } = await seedChatRow(db);

  await expect(
    chat.setProvider({ username: "owner", chatId, api: "chat-completions", source: "max-pro-sub" }),
  ).rejects.toMatchObject({ name: "ChatOperationError", reason: "invalid_provider" });
});

test("setProvider entering agent-sdk from the openrouter runner seeds a session from canon", async () => {
  const db = await freshDb();
  const sdk = fakeRunner("sdk reply");
  const raw = fakeRawRunner("raw reply");
  const chat = createChatService(db, { runTurn: sdk.run, runRaw: raw.run });
  const { chatId } = await seedChatRow(db);
  await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hi" }); // seq 1,2 of canon
  // Leave agent-sdk (drops session), then come back — re-entry must re-seed from canon.
  await chat.setProvider({ username: "owner", chatId, api: "responses", source: "openrouter" });
  await chat.setProvider({ username: "owner", chatId, api: "agent-sdk", source: "max-pro-sub" });

  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  expect(row?.api).toBe("agent-sdk");
  expect(row?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  const seeded = await db
    .select()
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, row?.sessionId ?? ""));
  expect(seeded.length).toBeGreaterThanOrEqual(2);
});

test("fork to raw branches canon at a seq into a new, independent chat", async () => {
  const db = await freshDb();
  const chat = createChatService(db, { runTurn: fakeRunner("reply").run });

  const { chatId } = await seedChatRow(db, { title: "Origin" });
  await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "one" }); // seq 1,2
  await chat.send({ username: "owner", chatId, expectedSeq: 2, content: "two" }); // seq 3,4

  const { chatId: forkId } = await chat.forkChat({
    username: "owner",
    chatId,
    atSeq: 2,
    targetApi: "responses",
    targetSource: "openrouter",
  });

  // The fork copied canon seq ≤ 2 (the first exchange) and nothing after.
  const forkMsgs = await chat.listMessages({ username: "owner", chatId: forkId });
  expect(forkMsgs.map((m) => m.seq)).toEqual([1, 2]);
  expect(forkMsgs[0]?.content).toBe("one");

  const forkRow = (await db.select().from(chats).where(eq(chats.id, forkId)))[0];
  expect(forkRow?.parentChatId).toBe(chatId);
  expect(forkRow?.forkedAt).not.toBeNull();
  expect(forkRow?.api).toBe("responses");
  expect(forkRow?.characterVersionId).toBe(
    (await db.select().from(chats).where(eq(chats.id, chatId)))[0]?.characterVersionId,
  ); // shares the pinned version (not a copy)

  // The source is untouched (still 4 messages, still sdk).
  const srcMsgs = await chat.listMessages({ username: "owner", chatId });
  expect(srcMsgs).toHaveLength(4);
});

test("fork to sdk seeds session_entries from canon + sets a valid-UUID sessionId", async () => {
  const db = await freshDb();
  const chat = createChatService(db, { runTurn: fakeRunner("reply").run });
  const { chatId } = await seedChatRow(db, { title: "Origin" });
  await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "one" }); // seq 1,2

  const { chatId: forkId } = await chat.forkChat({
    username: "owner",
    chatId,
    atSeq: 2,
    targetApi: "agent-sdk",
    targetSource: "max-pro-sub",
  });

  const forkRow = (await db.select().from(chats).where(eq(chats.id, forkId)))[0];
  expect(forkRow?.api).toBe("agent-sdk");
  expect(forkRow?.source).toBe("max-pro-sub");
  expect(forkRow?.sessionId).toMatch(/^[0-9a-f-]{36}$/); // a real uuidv4 (SDK rejects arbitrary ids)

  // The copied canon was seeded into the new chat's session as resumable frames.
  const seeded = await db
    .select()
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, forkRow?.sessionId ?? ""));
  expect(seeded.length).toBeGreaterThanOrEqual(2); // ≥ the user + assistant of the copied turn
  expect(seeded.every((f) => f.chatId === forkId)).toBe(true);
});

test("startChat keeps the greeting as seq 1, ahead of the first user message", async () => {
  const db = await freshDb();
  const { run } = fakeRunner("hi from the model");
  const chat = createChatService(db, { runTurn: run });
  const { characterVersionId } = await seedCharacter(db, {
    id: "c-greet",
    ownerId: "owner",
    name: "Aria",
    greetings: ["Welcome, traveler. I am Aria."],
  });

  const { chatId, result } = await chat.startChat({
    username: "owner",
    characterVersionId,
    firstUserMessage: "hello",
  });

  expect(result.status).toBe("ok");
  // Greeting (seq 1) → user (seq 2) → model reply (seq 3), persisted together at first send.
  const msgs = await chat.listMessages({ username: "owner", chatId });
  expect(msgs.map((m) => [m.seq, m.role])).toEqual([
    [1, "assistant"],
    [2, "user"],
    [3, "assistant"],
  ]);
  expect(msgs[0]?.content).toBe("Welcome, traveler. I am Aria.");
  // The greeting seeded the sdk session (so the first turn had context).
  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  expect(row?.sessionId).toBeTruthy();
});

test("startChat with generateOpening has the model write seq 1 (no user message)", async () => {
  const db = await freshDb();
  const { run, calls } = fakeRunner("*The tavern door creaks open.* Welcome!");
  const chat = createChatService(db, { runTurn: run });
  const { characterVersionId } = await seedCharacter(db, {
    id: "c-open",
    ownerId: "owner",
    name: "Aria",
  });

  const { chatId } = await chat.startChat({
    username: "owner",
    characterVersionId,
    generateOpening: true,
  });

  // The hidden open-scene prompt ran one turn; its reply is the opening message (row #1).
  expect(calls).toHaveLength(1);
  const msgs = await chat.listMessages({ username: "owner", chatId });
  expect(msgs).toHaveLength(1);
  expect(msgs[0]?.role).toBe("assistant");
  expect(msgs[0]?.content).toBe("*The tavern door creaks open.* Welcome!");
});

test("startChat requires exactly one commit trigger (neither/both → no chat row)", async () => {
  const db = await freshDb();
  const chat = createChatService(db, { runTurn: fakeRunner("x").run });
  const { characterVersionId } = await seedCharacter(db, {
    id: "c-none",
    ownerId: "owner",
    name: "Aria",
  });

  await expect(chat.startChat({ username: "owner", characterVersionId })).rejects.toThrow();
  await expect(
    chat.startChat({
      username: "owner",
      characterVersionId,
      firstUserMessage: "hi",
      generateOpening: true,
    }),
  ).rejects.toThrow();
  expect(await db.select().from(chats)).toHaveLength(0); // nothing committed
});

// ── 5E: swipes + edits ───────────────────────────────────────────────────────

test("swipe regenerates the last assistant turn as a new variant (migrating the original to idx 0)", async () => {
  const db = await freshDb();
  const { run } = seqRunner(["first reply", "second reply"]);
  const chat = createChatService(db, { runTurn: run });

  const { chatId } = await seedChatRow(db);
  await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hello" }); // assistant "first reply" @ seq 2

  // swipe mutates the tip — expectedSeq stays the chat's MAX (2), it does NOT advance seq.
  const result = await chat.swipe({ username: "owner", chatId, expectedSeq: 2 });

  expect(result.status).toBe("ok");
  const tip = result.status === "ok" ? result.messages.at(-1) : undefined;
  expect(tip?.seq).toBe(2); // still seq 2 — swipe doesn't extend the chat
  expect(tip?.content).toBe("second reply"); // the new generation is active
  expect(tip?.activeVariantIdx).toBe(1);
  expect(tip?.variantCount).toBe(2); // original (idx 0) + new (idx 1)
});

test("selectVariant flips back to an earlier swipe without regenerating", async () => {
  const db = await freshDb();
  const { run, calls } = seqRunner(["first reply", "second reply"]);
  const chat = createChatService(db, { runTurn: run });

  const { chatId } = await seedChatRow(db);
  await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hello" });
  await chat.swipe({ username: "owner", chatId, expectedSeq: 2 }); // now 2 variants, idx 1 active
  const callsAfterSwipe = calls.length;

  const tipId = (await chat.listMessages({ username: "owner", chatId })).at(-1)?.id ?? "";
  const msgs = await chat.selectVariant({
    username: "owner",
    chatId,
    messageId: tipId,
    variantIdx: 0,
  });

  expect(calls).toHaveLength(callsAfterSwipe); // NO model call — just a repoint
  const tip = msgs.at(-1);
  expect(tip?.activeVariantIdx).toBe(0);
  expect(tip?.content).toBe("first reply"); // back to the original generation
});

test("a greeting (seq-1 assistant, no user) can be swiped via the open-scene path", async () => {
  const db = await freshDb();
  const { run, calls } = seqRunner(["an alternate greeting"]);
  const chat = createChatService(db, { runTurn: run });

  // The transient "opened with a greeting, user hasn't replied yet" state (seq-1 assistant, session
  // seeded), produced directly — startChat would also add a user turn, so this is seeded by hand.
  const { chatId } = await seedChatRow(db, { greeting: "Welcome, traveler." });
  expect(calls).toHaveLength(0);

  const result = await chat.swipe({ username: "owner", chatId, expectedSeq: 1 });

  expect(result.status).toBe("ok");
  expect(calls).toHaveLength(1); // the regen ran (open-scene path, no preceding user)
  const tip = result.status === "ok" ? result.messages[0] : undefined;
  expect(tip?.seq).toBe(1);
  expect(tip?.content).toBe("an alternate greeting");
  expect(tip?.variantCount).toBe(2); // original greeting (idx 0) + the alternate (idx 1)
});

test("editMessage updates content + editedAt in place, no model call", async () => {
  const db = await freshDb();
  const { run, calls } = seqRunner(["a reply"]);
  const chat = createChatService(db, { runTurn: run });

  const { chatId } = await seedChatRow(db);
  await chat.send({ username: "owner", chatId, expectedSeq: 0, content: "hello" });
  const userMsgId = (await chat.listMessages({ username: "owner", chatId }))[0]?.id ?? "";

  const msgs = await chat.editMessage({
    username: "owner",
    chatId,
    messageId: userMsgId,
    content: "edited hello",
  });

  expect(calls).toHaveLength(1); // only the original send; edit makes no model call
  expect(msgs[0]?.content).toBe("edited hello");
  const row = (await db.select().from(messages).where(eq(messages.id, userMsgId)))[0];
  expect(row?.editedAt).not.toBeNull();
});

test("swipe on a chat whose tip is not an assistant turn throws not_swipeable", async () => {
  const db = await freshDb();
  const chat = createChatService(db, { runTurn: seqRunner(["x"]).run });
  const { chatId } = await seedChatRow(db); // blank chat, no messages

  await expect(chat.swipe({ username: "owner", chatId, expectedSeq: 0 })).rejects.toMatchObject({
    name: "ChatOperationError",
    reason: "not_swipeable",
  });
});

// ── 6: lifecycle metadata ───────────────────────────────────────────────────

test("updateTitle changes chat title", async () => {
  const db = await freshDb();
  const chat = createChatService(db, { runTurn: fakeRunner("x").run });

  const { chatId } = await seedChatRow(db, { title: "Original" });
  await chat.updateTitle({ username: "owner", chatId, title: "New Title" });

  const summary = (await chat.listChats({ username: "owner" }))[0];
  expect(summary?.title).toBe("New Title");
});

test("star toggles starred status", async () => {
  const db = await freshDb();
  const chat = createChatService(db, { runTurn: fakeRunner("x").run });

  const { chatId } = await seedChatRow(db);

  await chat.star({ username: "owner", chatId, starred: true });
  expect((await chat.getChat({ username: "owner", chatId })).starred).toBe(true);

  await chat.star({ username: "owner", chatId, starred: false });
  expect((await chat.getChat({ username: "owner", chatId })).starred).toBe(false);
});

test("archive toggles archived status", async () => {
  const db = await freshDb();
  const chat = createChatService(db, { runTurn: fakeRunner("x").run });

  const { chatId } = await seedChatRow(db);

  await chat.archive({ username: "owner", chatId, archived: true });
  expect((await chat.getChat({ username: "owner", chatId })).archived).toBe(true);

  await chat.archive({ username: "owner", chatId, archived: false });
  expect((await chat.getChat({ username: "owner", chatId })).archived).toBe(false);
});

test("delete removes chat completely", async () => {
  const db = await freshDb();
  const chat = createChatService(db, { runTurn: fakeRunner("x").run });

  const { chatId } = await seedChatRow(db);
  await chat.delete({ username: "owner", chatId });

  await expect(chat.getChat({ username: "owner", chatId })).rejects.toThrow(/not found/i);
  expect(await chat.listChats({ username: "owner" })).toHaveLength(0);
});
