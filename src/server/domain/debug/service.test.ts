import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db, runMigrations } from "../../../db/client";
import {
  characters,
  characterVersions,
  chats,
  messages,
  messageVariants,
  sessionEntries,
  users,
} from "../../../db/schema";
import { createDebugService } from "./service";

// In-memory libSQL (real, not mocked) per tests/AGENTS.md. Direct row inserts set up state — no
// provider needed, so this tests the inspector logic in isolation.
let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
  await runMigrations(db);
});

async function seedChat(): Promise<{ chatId: string; assistantMsgId: string }> {
  const now = Date.now();
  await db.insert(users).values({ id: "u1", handle: "owner", createdAt: now });
  await db.insert(characters).values({ id: "c1", ownerId: "u1", handle: "probe", createdAt: now });
  await db.insert(characterVersions).values({
    id: "v1",
    characterId: "c1",
    version: 1,
    name: "Probe",
    description: "a test character",
    greetings: ["hi"],
    createdAt: now,
  });
  await db.update(characters).set({ currentVersionId: "v1" }).where(eq(characters.id, "c1"));
  await db.insert(chats).values({
    id: "ch1",
    ownerId: "u1",
    title: "probe chat",
    characterVersionId: "v1",
    sessionId: "sess-1",
    messageCount: 3,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values([
    { id: "m1", chatId: "ch1", seq: 1, role: "assistant", content: "hi", createdAt: now },
    { id: "m2", chatId: "ch1", seq: 2, role: "user", content: "hello", createdAt: now },
    {
      id: "m3",
      chatId: "ch1",
      seq: 3,
      role: "assistant",
      content: "hey there",
      model: "claude-sonnet-4-6",
      provider: "agent-sdk/max-pro-sub",
      tokensIn: 200,
      tokensOut: 10,
      contextWindow: 200000,
      costUsd: 0.0007,
      activeVariantIdx: 1,
      createdAt: now,
    },
  ]);
  await db.insert(messageVariants).values([
    { id: "var0", messageId: "m3", idx: 0, content: "first gen", createdAt: now },
    { id: "var1", messageId: "m3", idx: 1, content: "hey there", tokensOut: 10, createdAt: now },
  ]);
  await db.insert(sessionEntries).values([
    {
      id: "se1",
      chatId: "ch1",
      sessionId: "sess-1",
      subpath: "",
      seq: 0,
      type: "user",
      entry: {},
      createdAt: now,
    },
    {
      id: "se2",
      chatId: "ch1",
      sessionId: "sess-1",
      subpath: "",
      seq: 1,
      type: "assistant",
      entry: {},
      createdAt: now,
    },
  ]);
  return { chatId: "ch1", assistantMsgId: "m3" };
}

describe("debug service", () => {
  test("stats counts zero on an empty db and reflects inserts", async () => {
    const svc = createDebugService(db);

    // Read counts through a Map — string-literal .get() args dodge BOTH the index-signature
    // dot/bracket conflict (tsc) and useNamingConvention on snake_case keys (Biome). See
    // docs/conventions.md.
    const empty = new Map(Object.entries((await svc.stats()).tables));
    expect(empty.get("chats")).toBe(0);
    expect(empty.get("messages")).toBe(0);

    await seedChat();
    const seeded = new Map(Object.entries((await svc.stats()).tables));

    expect(seeded.get("chats")).toBe(1);
    expect(seeded.get("messages")).toBe(3);
    expect(seeded.get("message_variants")).toBe(2);
    expect(seeded.get("session_entries")).toBe(2);
  });

  test("integrity check passes on a freshly migrated, FK-consistent db", async () => {
    const svc = createDebugService(db);
    await seedChat();

    const report = await svc.integrity();

    expect(report.ok).toBe(true);
    expect(report.foreignKeyViolations).toHaveLength(0);
    expect(report.integrityCheck).toEqual(["ok"]);
  });

  test("inspectChat dumps the chat, character, messages WITH provenance + variants, and frame count", async () => {
    const svc = createDebugService(db);
    const { chatId } = await seedChat();

    const result = await svc.inspectChat(chatId);

    expect(result.found).toBe(true);
    expect(result.chat?.id).toBe(chatId);
    expect(result.character?.name).toBe("Probe");
    expect(result.messages).toHaveLength(3);
    expect(result.sessionFrameCount).toBe(2);

    // The assistant turn carries full provenance (the columns chat.messages' projection hides).
    const assistant = result.messages.find((m) => m.seq === 3);
    expect(assistant?.tokensIn).toBe(200);
    expect(assistant?.costUsd).toBeCloseTo(0.0007);
    expect(assistant?.contextWindow).toBe(200000);

    // Its swipe variants come back, ordered by idx.
    expect(assistant?.variants).toHaveLength(2);
    expect(assistant?.variants.map((v) => v.idx)).toEqual([0, 1]);
  });

  test("inspectChat reports not-found for an unknown id", async () => {
    const svc = createDebugService(db);

    const result = await svc.inspectChat("does-not-exist");

    expect(result.found).toBe(false);
    expect(result.chat).toBeNull();
    expect(result.messages).toHaveLength(0);
  });
});
