import { describe, expect, test } from "vitest";
import { freshDb } from "../../../../tests/support/db";
import { chats, users } from "../../../db/schema";
import { createCharacterService } from "./service";
import { CharacterNotFoundError, CharacterOperationError } from "./types";

describe("CharacterService", () => {
  test("create: inserts character and version 1", async () => {
    const db = await freshDb();
    const service = createCharacterService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });

    const c = await service.create(
      { username: "user" },
      {
        handle: "char-1",
        name: "My Char",
        description: "A description",
      },
    );

    expect(c.handle).toBe("char-1");
    expect(c.name).toBe("My Char");
    expect(c.version).toBe(1);
    expect(c.pinned).toBe(false);
  });

  test("create: rejects duplicate handle", async () => {
    const db = await freshDb();
    const service = createCharacterService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });

    await service.create({ username: "user" }, { handle: "char-1", name: "1", description: "1" });
    await expect(
      service.create({ username: "user" }, { handle: "char-1", name: "2", description: "2" }),
    ).rejects.toThrow(CharacterOperationError);
  });

  test("update: mutates in-place when not pinned", async () => {
    const db = await freshDb();
    const service = createCharacterService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });

    const c = await service.create(
      { username: "user" },
      { handle: "char-1", name: "N1", description: "D1" },
    );

    const updated = await service.update({ username: "user" }, c.id, {
      name: "N2",
      description: "D2",
    });

    expect(updated.name).toBe("N2");
    expect(updated.version).toBe(1); // Did not fork
    expect(updated.currentVersionId).toBe(c.currentVersionId);
  });

  test("update: forks new version when pinned", async () => {
    const db = await freshDb();
    const service = createCharacterService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });

    const c = await service.create(
      { username: "user" },
      { handle: "char-1", name: "N1", description: "D1" },
    );

    // Pin the version
    await db.insert(chats).values({
      id: "chat-1",
      ownerId: "u1",
      title: "Chat",
      characterVersionId: c.currentVersionId as string,
      api: "agent-sdk",
      source: "max-pro-sub",
      createdAt: 1,
      updatedAt: 1,
    });

    const updated = await service.update({ username: "user" }, c.id, {
      name: "N2",
      description: "D2",
    });

    expect(updated.name).toBe("N2");
    expect(updated.version).toBe(2); // Forked!
    expect(updated.currentVersionId).not.toBe(c.currentVersionId);
  });

  test("remove: deletes character and cascades to versions", async () => {
    const db = await freshDb();
    const service = createCharacterService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });

    const c = await service.create(
      { username: "user" },
      { handle: "char-1", name: "N1", description: "D1" },
    );

    const res = await service.remove({ username: "user" }, c.id);
    expect(res.deleted).toBe(true);

    await expect(service.get({ username: "user" }, c.id)).rejects.toThrow(CharacterNotFoundError);
  });

  test("remove: rejected if any version is pinned", async () => {
    const db = await freshDb();
    const service = createCharacterService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });

    const c = await service.create(
      { username: "user" },
      { handle: "char-1", name: "N1", description: "D1" },
    );

    await db.insert(chats).values({
      id: "chat-1",
      ownerId: "u1",
      title: "Chat",
      characterVersionId: c.currentVersionId as string,
      api: "agent-sdk",
      source: "max-pro-sub",
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(service.remove({ username: "user" }, c.id)).rejects.toThrow(
      CharacterOperationError,
    );
  });
});
