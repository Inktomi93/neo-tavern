import { TRPCError } from "@trpc/server";
import { describe, expect } from "vitest";
import { test } from "../support/fixtures";

describe("characterRouter", () => {
  test("create validates input and calls domain service", async ({ ownerCaller }) => {
    // Fails zod validation (name too long, max 200)
    await expect(
      ownerCaller.character.create({
        handle: "char-1",
        name: "a".repeat(201),
        description: "Desc",
      }),
    ).rejects.toThrow(/too_big/i);

    // Success
    const c = await ownerCaller.character.create({
      handle: "char-1",
      name: "Valid Name",
      description: "Valid Desc",
    });

    expect(c.handle).toBe("char-1");
    expect(c.name).toBe("Valid Name");
    expect(c.description).toBe("Valid Desc");
    expect(c.version).toBe(1);
  });

  test("get throws NOT_FOUND for missing character", async ({ ownerCaller }) => {
    await expect(ownerCaller.character.get({ characterId: "bogus" })).rejects.toThrow(TRPCError);

    try {
      await ownerCaller.character.get({ characterId: "bogus" });
    } catch (e) {
      expect(e instanceof TRPCError).toBe(true);
      expect((e as TRPCError).code).toBe("NOT_FOUND");
    }
  });

  test("update validates input and edits character", async ({ ownerCaller }) => {
    const c = await ownerCaller.character.create({
      handle: "char-1",
      name: "Valid Name",
      description: "Valid Desc",
    });

    // Fails zod validation (starred is boolean)
    await expect(
      ownerCaller.character.update({
        characterId: c.id,
        // @ts-expect-error Intentionally passing invalid type
        starred: "not-a-boolean",
      }),
    ).rejects.toThrow();

    const updated = await ownerCaller.character.update({
      characterId: c.id,
      name: "New Name",
      description: "New Desc",
    });

    expect(updated.name).toBe("New Name");
  });

  test("list returns user characters", async ({ ownerCaller }) => {
    await ownerCaller.character.create({ handle: "c1", name: "C1", description: "1" });
    await ownerCaller.character.create({ handle: "c2", name: "C2", description: "2" });

    const list = await ownerCaller.character.list();
    expect(list).toHaveLength(2);
    // Ordered by desc(createdAt)
    expect(list[0]?.handle).toBe("c2");
    expect(list[1]?.handle).toBe("c1");
  });
});
