import { eq } from "drizzle-orm";
import { createDb, type Db, runMigrations } from "../../src/db/client";
import { characters, characterVersions, chats, messages, users } from "../../src/db/schema";
import { env } from "../../src/server/env";
import type { ChatApi, ChatSource } from "../../src/shared/chat-routing";
import {
  type CharacterId,
  type CharacterVersionId,
  type ChatId,
  castId,
} from "../../src/shared/ids";

// Fresh in-memory libSQL with migrations applied. Per tests/AGENTS.md: call per test
// (not a shared singleton) so each test gets an isolated database.
export async function freshDb(): Promise<Db> {
  const db = await createDb(":memory:");
  await runMigrations(db);
  return db;
}

/**
 * Seed the full character FK chain (user → character → current version) so a row can hang off it —
 * e.g. character_embeddings, which has FKs to all three (PRAGMA foreign_keys = ON in tests). The
 * user insert is idempotent (a shared owner across calls). Returns the ids needed to embed/link.
 */
export async function seedCharacter(
  db: Db,
  opts: {
    id: string;
    ownerId: string;
    handle?: string;
    name?: string;
    description?: string;
    tags?: string[];
    greetings?: string[];
  },
): Promise<{ characterId: CharacterId; ownerId: string; characterVersionId: CharacterVersionId }> {
  const now = Date.now();
  const cvId = `${opts.id}-v1`;
  // Mirror ensureUser's one access decision so the seeded owner is REALISTIC: the DEFAULT_USER_HANDLE
  // owner is admin (everyone else a plain user). The turn-time credential resolver gates max-pro-sub
  // on role, so a seeded owner that wasn't admin would be wrongly refused its own sub.
  await db
    .insert(users)
    .values({
      id: opts.ownerId,
      handle: opts.ownerId,
      role: opts.ownerId === env.DEFAULT_USER_HANDLE ? "admin" : "user",
      createdAt: now,
    })
    .onConflictDoNothing();
  await db
    .insert(characters)
    .values({ id: opts.id, ownerId: opts.ownerId, handle: opts.handle ?? opts.id, createdAt: now });
  await db.insert(characterVersions).values({
    id: cvId,
    characterId: opts.id,
    version: 1,
    name: opts.name ?? opts.id,
    description: opts.description ?? "a character",
    tags: opts.tags ?? [],
    greetings: opts.greetings ?? [],
    createdAt: now,
  });
  await db.update(characters).set({ currentVersionId: cvId }).where(eq(characters.id, opts.id));
  return {
    characterId: castId<CharacterId>(opts.id),
    ownerId: opts.ownerId,
    characterVersionId: castId<CharacterVersionId>(cvId),
  };
}

let chatSeedCounter = 0;

/**
 * Seed a committed chat row (+ its character version) directly — the eager "scaffold" used as test
 * setup, now that the public API only commits via `startChat` (a turn). Mirrors how `read.test.ts`
 * sets up state by direct insert. Defaults to an empty agent-sdk chat (messageCount 0) so existing
 * `send(expectedSeq: 0, …)` flows work unchanged. Returns the ids the test operates on.
 */
export async function seedChatRow(
  db: Db,
  opts: {
    ownerId?: string;
    title?: string;
    name?: string;
    description?: string;
    api?: ChatApi;
    source?: ChatSource;
    model?: string | null;
    // Seed a lone greeting (seq-1 assistant) + the agent-sdk session — the transient "opened with a
    // greeting, user hasn't replied" state, for swipe/edit tests. Mirrors lifecycle's seedGreeting.
    greeting?: string;
  } = {},
): Promise<{ chatId: ChatId; characterVersionId: CharacterVersionId; ownerId: string }> {
  const ownerId = opts.ownerId ?? "owner";
  const n = chatSeedCounter++;
  const api = opts.api ?? "agent-sdk";
  const { characterVersionId } = await seedCharacter(db, {
    id: `seedchar-${n}`,
    ownerId,
    name: opts.name ?? "Aria",
    description: opts.description ?? "a test character",
    greetings: opts.greeting ? [opts.greeting] : [],
  });
  const chatId = castId<ChatId>(`seedchat-${n}`);
  const now = Date.now();
  await db.insert(chats).values({
    id: chatId,
    ownerId,
    title: opts.title ?? "T",
    characterVersionId,
    api,
    source: opts.source ?? "max-pro-sub",
    ...(opts.model != null ? { model: opts.model } : {}),
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  if (opts.greeting) {
    // The lone seq-1 greeting (no preceding user). The agent-sdk greeting-swipe path uses a FRESH
    // session (swipe.ts), so no pre-seeded session is needed here — keep the helper free of chat
    // internals (front-door rule). Tests needing a real first turn use startChat instead.
    await db.insert(messages).values({
      id: `seedmsg-${n}`,
      chatId,
      seq: 1,
      role: "assistant",
      content: opts.greeting,
      createdAt: now,
    });
    await db.update(chats).set({ messageCount: 1 }).where(eq(chats.id, chatId));
  }
  return { chatId, characterVersionId, ownerId };
  // chatId/characterVersionId are branded (castId above) so callers get typed ids for free.
}
