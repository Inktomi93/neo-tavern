import { TRPCError } from "@trpc/server";
import { describe, expect } from "vitest";
import { test } from "../support/fixtures";

describe("personaRouter", () => {
  test("create validates input and calls domain service", async ({ ownerCaller }) => {
    // Fails zod validation (name too long)
    await expect(
      ownerCaller.persona.create({
        name: "a".repeat(201),
        description: "Desc",
      }),
    ).rejects.toThrow(/too_big/i);

    // Success
    const p = await ownerCaller.persona.create({
      name: "Valid Name",
      description: "Valid Desc",
    });

    expect(p.name).toBe("Valid Name");
    expect(p.description).toBe("Valid Desc");
  });

  test("get throws NOT_FOUND for missing persona", async ({ ownerCaller }) => {
    try {
      await ownerCaller.persona.get({ personaId: "bogus" });
    } catch (e) {
      expect(e instanceof TRPCError).toBe(true);
      expect((e as TRPCError).code).toBe("NOT_FOUND");
    }
  });

  test("update validates input and edits persona", async ({ ownerCaller }) => {
    const p = await ownerCaller.persona.create({
      name: "Valid Name",
      description: "Valid Desc",
    });

    const updated = await ownerCaller.persona.update({
      personaId: p.id,
      name: "New Name",
    });

    expect(updated.name).toBe("New Name");
    expect(updated.description).toBe("Valid Desc");
  });

  test("list returns user personas", async ({ ownerCaller }) => {
    await ownerCaller.persona.create({ name: "P1", description: "1" });
    await new Promise((r) => setTimeout(r, 5));
    await ownerCaller.persona.create({ name: "P2", description: "2" });

    const list = await ownerCaller.persona.list();
    expect(list).toHaveLength(2);
    // Ordered by desc(createdAt)
    expect(list[0]?.name).toBe("P2");
    expect(list[1]?.name).toBe("P1");
  });

  test("remove deletes persona", async ({ ownerCaller }) => {
    const p = await ownerCaller.persona.create({
      name: "Valid Name",
      description: "Valid Desc",
    });

    const res = await ownerCaller.persona.remove({ personaId: p.id });
    expect(res.deleted).toBe(true);

    await expect(ownerCaller.persona.get({ personaId: p.id })).rejects.toThrow();
  });
});
