import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db, runMigrations } from "../../../db/client";
import { characters, characterVersions, chats, messages, users } from "../../../db/schema";
import { type ChatId, castId } from "../../../shared/ids";
import { estimateTokens } from "../../../shared/tokens";
import { createChatService } from "./service";
import { ChatNotFoundError } from "./types";

const CH1 = castId<ChatId>("ch1");

// Read paths (listChats / getChat / enriched listMessages) need no provider — direct row inserts
// set up state, then assert through the service's public API. In-memory libSQL per tests/AGENTS.md.
let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
  await runMigrations(db);
});

async function seedCharacter(): Promise<string> {
  const now = Date.now();
  // ownerId == handle here so the service's ensureUser(handle) resolves back to the same id.
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
  return "v1";
}

describe("chat read paths", () => {
  test("listChats returns the owner's chats newest-updated first, with character name", async () => {
    const svc = createChatService(db);
    const versionId = await seedCharacter();
    await db.insert(users).values({ id: "u2", handle: "u2", createdAt: Date.now() });
    await db.insert(chats).values([
      {
        id: "ch-old",
        ownerId: "u1",
        title: "older",
        characterVersionId: versionId,
        model: "claude-sonnet-4-6",
        messageCount: 4,
        totalTokensIn: 100,
        totalTokensOut: 20,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: "ch-new",
        ownerId: "u1",
        title: "newer",
        characterVersionId: versionId,
        createdAt: 2000,
        updatedAt: 2000,
      },
      // a DIFFERENT owner's chat must not leak into u1's list
      {
        id: "ch-other",
        ownerId: "u2",
        title: "other",
        characterVersionId: versionId,
        createdAt: 3000,
        updatedAt: 3000,
      },
    ]);

    const list = await svc.listChats({ username: "u1" });

    expect(list.map((c) => c.id)).toEqual(["ch-new", "ch-old"]);
    const old = list.find((c) => c.id === "ch-old");
    expect(old?.characterName).toBe("Probe");
    expect(old?.model).toBe("claude-sonnet-4-6");
    expect(old?.messageCount).toBe(4);
    expect(old?.totalTokensIn).toBe(100);
    // schema defaults surface as concrete values, not null
    const fresh = list.find((c) => c.id === "ch-new");
    expect(fresh?.messageCount).toBe(0);
    expect(fresh?.starred).toBe(false);
  });

  test("getChat returns detail (pins/links) and throws ChatNotFoundError for an unowned chat", async () => {
    const svc = createChatService(db);
    const versionId = await seedCharacter();
    await db.insert(chats).values({
      id: "ch1",
      ownerId: "u1",
      title: "mine",
      characterVersionId: versionId,
      sessionId: "sess-1",
      createdAt: 10,
      updatedAt: 10,
    });

    const detail = await svc.getChat({ username: "u1", chatId: CH1 });
    expect(detail.title).toBe("mine");
    expect(detail.characterName).toBe("Probe");
    expect(detail.characterId).toBe("c1");
    expect(detail.characterVersionId).toBe(versionId);
    expect(detail.hasSession).toBe(true);

    // ensureUser("u2") makes u2 a real user, so this is "exists-but-not-yours" → NOT_FOUND, not a leak.
    await expect(svc.getChat({ username: "u2", chatId: CH1 })).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
  });

  test("listMessages exposes per-message provenance columns (not just the lean projection)", async () => {
    const svc = createChatService(db);
    const versionId = await seedCharacter();
    await db.insert(chats).values({
      id: "ch1",
      ownerId: "u1",
      title: "mine",
      characterVersionId: versionId,
      createdAt: 10,
      updatedAt: 10,
    });
    await db.insert(messages).values({
      id: "m1",
      chatId: "ch1",
      seq: 1,
      role: "assistant",
      content: "hi",
      model: "claude-sonnet-4-6",
      provider: "agent-sdk/max-pro-sub",
      tokensIn: 200,
      tokensOut: 10,
      contextWindow: 200000,
      costUsd: 0.0007,
      createdAt: 10,
    });

    const [msg] = await svc.listMessages({ username: "u1", chatId: CH1 });

    expect(msg?.tokensIn).toBe(200);
    expect(msg?.contextWindow).toBe(200000);
    expect(msg?.provider).toBe("agent-sdk/max-pro-sub");
    expect(msg?.costUsd).toBeCloseTo(0.0007);
  });

  test("previewAssembly dry-runs the prompt + routing without a model call", async () => {
    const svc = createChatService(db);
    const versionId = await seedCharacter();
    await db.insert(chats).values({
      id: "ch1",
      ownerId: "u1",
      title: "mine",
      characterVersionId: versionId,
      createdAt: 10,
      updatedAt: 10,
    });

    const preview = await svc.previewAssembly({ username: "u1", chatId: CH1 });

    // Defaults: agent-sdk on the sub, the resolver's default model, the default preset.
    expect(preview.routing).toMatchObject({
      runner: "agent-sdk",
      api: "agent-sdk",
      source: "max-pro-sub",
    });
    expect(preview.preset).toBe("default");
    // The character assembled into a non-empty static (cacheable) prefix; no persona attached.
    expect(preview.systemPrompt.static.length).toBeGreaterThan(0);
    // Generic QuadChars estimate of that prefix (shared/tokens.ts) — replaces the old raw char count.
    expect(preview.trace.staticTokens).toBe(estimateTokens(preview.systemPrompt.static));
    expect(preview.trace.hasPersona).toBe(false);
  });
});
