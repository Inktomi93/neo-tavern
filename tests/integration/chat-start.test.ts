import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { chats, userSettings } from "../../src/db/schema";
import { createSecretBox } from "../../src/server/crypto/secrets";
import { storeUserKey } from "../../src/server/domain/_shared/credentials";
import { ensureUser } from "../../src/server/domain/_shared/users";
import { type ChatServiceDeps, createChatService } from "../../src/server/domain/chat";
import type { ChatTurnResult } from "../../src/server/providers/turn";
import type { UserSettings } from "../../src/shared/user-settings";
import { freshDb, seedCharacter } from "../support/db";

function cannedTurn(reply: string): ChatTurnResult {
  return {
    reply,
    sessionId: "sess-1",
    stopReason: "end_turn",
    terminalReason: "completed",
    finishReason: "stop",
    ttftMs: 100,
    durationApiMs: null,
    apiErrorStatus: null,
    numTurns: 1,
    usage: {
      model: "fake",
      tokensIn: 5,
      tokensOut: 3,
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

const fakeRun = () => Promise.resolve(cannedTurn("ok"));

async function setUserSettings(
  db: Awaited<ReturnType<typeof freshDb>>,
  ownerId: string,
  config: Partial<UserSettings>,
): Promise<void> {
  await db
    .insert(userSettings)
    .values({ userId: ownerId, schemaVersion: 1, config, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: userSettings.userId, set: { config } });
}

// A chat service whose openrouter turns are HERMETIC: the owner gets a stored BYO key + a real
// secret box, so the turn-time resolver never depends on a host OPENROUTER_API_KEY (which is going
// away). The injected runner mocks still drive routing; the BYO key just satisfies the credential gate.
async function byoChatService(
  db: Awaited<ReturnType<typeof freshDb>>,
  deps: ChatServiceDeps,
): Promise<ReturnType<typeof createChatService>> {
  const secretBox = createSecretBox(randomBytes(32));
  const ownerId = await ensureUser(db, "owner");
  await storeUserKey(db, secretBox, ownerId, "openrouter", "sk-or-owner-byok");
  return createChatService(db, { ...deps, secretBox });
}

test("startChat seeds api/source/model from user settings when the caller omits them", async () => {
  const db = await freshDb();
  const { characterVersionId } = await seedCharacter(db, {
    id: "c1",
    ownerId: "owner",
    name: "Aria",
  });
  await setUserSettings(db, "owner", {
    defaultApi: "responses",
    defaultSource: "openrouter",
    defaultModel: "x/y",
  });
  const calls: string[] = [];
  const chat = await byoChatService(db, {
    runRaw: async () => {
      calls.push("raw");
      return cannedTurn("opening");
    },
  });

  const { chatId } = await chat.startChat({
    username: "owner",
    characterVersionId,
    generateOpening: true,
  });

  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  expect(row?.api).toBe("responses");
  expect(row?.source).toBe("openrouter");
  expect(row?.model).toBe("x/y");
  expect(calls).toEqual(["raw"]); // routed through the openrouter runner, not agent-sdk
});

test("an explicit arg overrides the user default (seed semantics: caller wins)", async () => {
  const db = await freshDb();
  const { characterVersionId } = await seedCharacter(db, {
    id: "c1",
    ownerId: "owner",
    name: "Aria",
  });
  await setUserSettings(db, "owner", { defaultApi: "responses", defaultSource: "openrouter" });
  const chat = createChatService(db, { runTurn: fakeRun });

  const { chatId } = await chat.startChat({
    username: "owner",
    characterVersionId,
    api: "agent-sdk",
    source: "max-pro-sub",
    firstUserMessage: "hello",
  });

  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  expect(row?.api).toBe("agent-sdk"); // the explicit arg beat the user default
  expect(row?.source).toBe("max-pro-sub");
});

test("a stale defaultPresetId / defaultPersonaId degrades to null (never fails creation)", async () => {
  const db = await freshDb();
  const { characterVersionId } = await seedCharacter(db, {
    id: "c1",
    ownerId: "owner",
    name: "Aria",
  });
  await setUserSettings(db, "owner", {
    defaultPresetId: "ghost-preset",
    defaultPersonaId: "ghost-persona",
  });
  const chat = createChatService(db, { runTurn: fakeRun });

  const { chatId } = await chat.startChat({
    username: "owner",
    characterVersionId,
    firstUserMessage: "hello",
  });

  const row = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  expect(row?.presetVersionId).toBeNull(); // stale id → default prompt config
  expect(row?.personaId).toBeNull();
});

test("max-pro-sub is owner-only: a non-owner with no explicit source is rejected", async () => {
  const db = await freshDb();
  await ensureUser(db, "owner"); // the real owner exists
  const { characterVersionId } = await seedCharacter(db, {
    id: "c-intruder",
    ownerId: "intruder",
    name: "Aria",
  });
  const chat = createChatService(db, { runTurn: fakeRun });

  // No source → would default to max-pro-sub (the owner's credential) → guarded.
  await expect(
    chat.startChat({ username: "intruder", characterVersionId, firstUserMessage: "hi" }),
  ).rejects.toThrow(/max-pro-sub/);
  expect(await db.select().from(chats)).toHaveLength(0); // nothing committed
});

test("generateOpening on an openrouter chat routes through the openrouter runner (case 2)", async () => {
  const db = await freshDb();
  const { characterVersionId } = await seedCharacter(db, {
    id: "c1",
    ownerId: "owner",
    name: "Aria",
  });
  let rawCalls = 0;
  const chat = await byoChatService(db, {
    runRaw: async () => {
      rawCalls++;
      return cannedTurn("*the door opens*");
    },
  });

  const { chatId } = await chat.startChat({
    username: "owner",
    characterVersionId,
    api: "responses",
    source: "openrouter",
    model: "x/y",
    generateOpening: true,
  });

  expect(rawCalls).toBe(1);
  const msgs = await chat.listMessages({ username: "owner", chatId });
  expect(msgs).toHaveLength(1);
  expect(msgs[0]?.role).toBe("assistant");
  expect(msgs[0]?.content).toBe("*the door opens*");
});
