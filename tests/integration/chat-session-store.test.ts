import type { SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { createChatService } from "../../src/server/domain/chat";
import { DbSessionStore } from "../../src/server/domain/chat/store";
import { freshDb } from "../support/db";

// The compaction artifact the SDK ACTUALLY persists (measured via scripts/sdk-compaction-probe.ts,
// NOT from the type docs): a `system`/`compact_boundary` frame carrying only "Conversation
// compacted" + camelCase compactMetadata — no preserved_messages relink — and a SEPARATE synthetic
// `user` frame holding the prose summary ("This session is being continued…").
interface CompactMetadata {
  trigger: string;
  preTokens: number;
  postTokens: number;
}

// A real chat row (so session_entries.chatId satisfies its FK), with a runner that's
// never invoked — these tests exercise the store directly, not a turn.
async function chatFixture() {
  const db = await freshDb();
  const chat = createChatService(db, {
    runTurn: () => Promise.reject(new Error("runner unused in store tests")),
  });
  const { chatId } = await chat.create({
    username: "owner",
    title: "T",
    characterName: "Aria",
    characterDescription: "a test character",
  });
  return { db, chatId };
}

const key: SessionKey = { projectKey: "test", sessionId: "sess-store" };

test("the session store round-trips frames in seq order", async () => {
  const { db, chatId } = await chatFixture();
  const store = new DbSessionStore(db, chatId);

  const frames: SessionStoreEntry[] = [
    { type: "user", uuid: "u1" },
    { type: "assistant", uuid: "a1" },
  ];
  await store.append(key, frames);

  const loaded = await store.load(key);
  expect(loaded?.map((entry) => entry.type)).toEqual(["user", "assistant"]);
});

test("the real compaction frames (boundary + summary) round-trip in seq order", async () => {
  const { db, chatId } = await chatFixture();
  const store = new DbSessionStore(db, chatId);

  // Resume-after-compaction depends on our store replaying the SDK's compaction frames
  // intact and ordered. These are the SHAPES MEASURED FROM A REAL COMPACTION (probe), not
  // the .d.ts: a `system`/`compact_boundary` marker that resets the chain root
  // (parentUuid:null) + a synthetic `user` frame carrying the summary prose.
  const boundary: SessionStoreEntry = {
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    uuid: "c1",
    parentUuid: null,
    logicalParentUuid: "a1",
    compactMetadata: { trigger: "auto", preTokens: 3841, postTokens: 406 },
  };
  const summary: SessionStoreEntry = {
    type: "user",
    uuid: "s1",
    parentUuid: "c1",
    message: {
      role: "user",
      content: "This session is being continued from a previous conversation… Summary: …",
    },
  };
  await store.append(key, [
    { type: "user", uuid: "u1" },
    { type: "assistant", uuid: "a1" },
    boundary,
    summary,
  ]);

  const loaded = await store.load(key);
  expect(loaded?.map((entry) => entry.type)).toEqual(["user", "assistant", "system", "user"]);

  // The boundary marker survives intact: subtype + the camelCase compactMetadata. (Cast to a
  // declared-key shape so dot access satisfies both tsc and Biome.)
  const marker = loaded?.[2] as
    | { subtype: string; parentUuid: null; compactMetadata: CompactMetadata }
    | undefined;
  expect(marker?.subtype).toBe("compact_boundary");
  expect(marker?.parentUuid).toBeNull(); // it resets the chain root — "the start of the convo"
  expect(marker?.compactMetadata.trigger).toBe("auto");
  expect(marker?.compactMetadata.preTokens).toBe(3841);
});

test("append is idempotent on a replayed uuid (the SDK re-emits on retry)", async () => {
  const { db, chatId } = await chatFixture();
  const store = new DbSessionStore(db, chatId);

  await store.append(key, [{ type: "user", uuid: "dup" }]);
  await store.append(key, [{ type: "user", uuid: "dup" }]); // same uuid replayed

  const loaded = await store.load(key);
  expect(loaded).toHaveLength(1); // the (session_id, subpath, uuid) unique index deduped it
});
