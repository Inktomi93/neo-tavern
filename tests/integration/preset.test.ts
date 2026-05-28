import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { Db } from "../../src/db/client";
import { characters, characterVersions, chats, presetVersions } from "../../src/db/schema";
import { newId } from "../../src/server/domain/_shared/ids";
import { ensureUser } from "../../src/server/domain/_shared/users";
import {
  createPresetService,
  PresetNotFoundError,
  PresetOperationError,
} from "../../src/server/domain/preset";
import type { PromptConfig } from "../../src/shared/prompt-config";
import { freshDb } from "../support/db";

const customConfig: PromptConfig = {
  schemaVersion: 1,
  sections: [
    { type: "literal", id: "x", name: "X", role: "system", content: "CUSTOM", enabled: true },
  ],
  params: {},
  regexScripts: [],
};

// Pin a preset version by pointing a real chat at it (the RESTRICT FK that makes it immutable).
// Minimal chain: character → version → chat(presetVersionId). Returns the chat id.
async function pinVersion(db: Db, ownerId: string, versionId: string): Promise<string> {
  const now = Date.now();
  const charId = newId();
  await db.insert(characters).values({ id: charId, ownerId, handle: newId(), createdAt: now });
  const cvId = newId();
  await db.insert(characterVersions).values({
    id: cvId,
    characterId: charId,
    version: 1,
    name: "C",
    description: "d",
    createdAt: now,
  });
  const chatId = newId();
  await db.insert(chats).values({
    id: chatId,
    ownerId,
    title: "pinned chat",
    characterVersionId: cvId,
    presetVersionId: versionId,
    createdAt: now,
    updatedAt: now,
  });
  return chatId;
}

test("create seeds v1 from the default config; get/list round-trip", async () => {
  const db = await freshDb();
  const svc = createPresetService(db);

  const created = await svc.create({ username: "owner", name: "RP default", kind: "chat" });
  expect(created.version).toBe(1);
  expect(created.pinned).toBe(false);
  expect(created.currentVersionId).not.toBeNull();
  expect(created.config.sections.length).toBeGreaterThan(0); // seeded from DEFAULT_PROMPT_CONFIG

  const list = await svc.list({ username: "owner" });
  expect(list).toHaveLength(1);
  expect(list[0]?.id).toBe(created.id);

  const got = await svc.get({ username: "owner", presetId: created.id });
  expect(got.id).toBe(created.id);
  expect(got.name).toBe("RP default");
});

test("update edits name/kind in place and mutates an UNPINNED version's config in place", async () => {
  const db = await freshDb();
  const svc = createPresetService(db);
  const p = await svc.create({ username: "owner", name: "n", kind: "k" });

  const updated = await svc.update({
    username: "owner",
    presetId: p.id,
    name: "renamed",
    kind: "k2",
    config: customConfig,
  });

  expect(updated.name).toBe("renamed");
  expect(updated.kind).toBe("k2");
  expect(updated.version).toBe(1); // unpinned → mutated in place, NOT a new version
  expect(updated.currentVersionId).toBe(p.currentVersionId);
  expect(updated.config.sections[0]?.type).toBe("literal");
  expect(updated.config.sections).toHaveLength(1);
  // exactly one version row exists (no fork)
  const versions = await db.select().from(presetVersions).where(eq(presetVersions.presetId, p.id));
  expect(versions).toHaveLength(1);
});

test("editing a PINNED version forks v2 + repoints; the pinned v1 is preserved as provenance", async () => {
  const db = await freshDb();
  const svc = createPresetService(db);
  const ownerId = await ensureUser(db, "owner");
  const p = await svc.create({ username: "owner", name: "n", kind: "k" });
  const v1Id = p.currentVersionId;
  if (v1Id === null) throw new Error("expected a current version");

  await pinVersion(db, ownerId, v1Id); // now a chat records v1 as its basis → immutable

  const updated = await svc.update({ username: "owner", presetId: p.id, config: customConfig });
  expect(updated.version).toBe(2); // forked
  expect(updated.currentVersionId).not.toBe(v1Id);
  expect(updated.config.sections).toHaveLength(1); // the new config

  // Two versions now; v1 keeps its ORIGINAL (default) config — past provenance untouched.
  const versions = await db.select().from(presetVersions).where(eq(presetVersions.presetId, p.id));
  expect(versions).toHaveLength(2);
  const v1 = versions.find((v) => v.id === v1Id);
  expect(v1?.version).toBe(1);
  // the pinning chat still points at v1 (provenance intact)
  const pinnedChat = (await db.select().from(chats).where(eq(chats.presetVersionId, v1Id)))[0];
  expect(pinnedChat).toBeDefined();
});

test("remove refuses a pinned preset (preset_in_use) and deletes an unpinned one", async () => {
  const db = await freshDb();
  const svc = createPresetService(db);
  const ownerId = await ensureUser(db, "owner");

  const pinned = await svc.create({ username: "owner", name: "pinned", kind: "k" });
  if (pinned.currentVersionId === null) throw new Error("expected a version");
  await pinVersion(db, ownerId, pinned.currentVersionId);
  await expect(svc.remove({ username: "owner", presetId: pinned.id })).rejects.toBeInstanceOf(
    PresetOperationError,
  );

  const free = await svc.create({ username: "owner", name: "free", kind: "k" });
  await expect(svc.remove({ username: "owner", presetId: free.id })).resolves.toEqual({
    deleted: true,
  });
  const list = await svc.list({ username: "owner" });
  expect(list.map((s) => s.id)).not.toContain(free.id);
  expect(list.map((s) => s.id)).toContain(pinned.id);
});

test("owner scoping: another user can neither read nor edit a preset", async () => {
  const db = await freshDb();
  const svc = createPresetService(db);
  const p = await svc.create({ username: "owner", name: "n", kind: "k" });

  await expect(svc.get({ username: "intruder", presetId: p.id })).rejects.toBeInstanceOf(
    PresetNotFoundError,
  );
  await expect(
    svc.update({ username: "intruder", presetId: p.id, name: "hijack" }),
  ).rejects.toBeInstanceOf(PresetNotFoundError);
});
