import { describe, expect, test } from "vitest";
import { freshDb } from "../../../../tests/support/db";
import { users } from "../../../db/schema";
import { castId, type PersonaId } from "../../../shared/ids";
import { createPersonaService } from "./service";
import { PersonaNotFoundError } from "./types";

describe("PersonaService", () => {
  test("create: inserts persona", async () => {
    const db = await freshDb();
    const service = createPersonaService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });

    const p = await service.create(
      { username: "user" },
      {
        name: "My Persona",
        description: "A cool guy",
      },
    );

    expect(p.name).toBe("My Persona");
    expect(p.description).toBe("A cool guy");
  });

  test("get: retrieves persona", async () => {
    const db = await freshDb();
    const service = createPersonaService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });

    const p = await service.create({ username: "user" }, { name: "N1", description: "D1" });
    const fetched = await service.get({ username: "user" }, p.id);

    expect(fetched.id).toBe(p.id);
    expect(fetched.name).toBe("N1");
  });

  test("get: throws if missing or unowned", async () => {
    const db = await freshDb();
    const service = createPersonaService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });
    await db.insert(users).values({ id: "u2", handle: "user2", createdAt: 1 });

    const p = await service.create({ username: "user" }, { name: "N1", description: "D1" });

    await expect(service.get({ username: "user" }, castId<PersonaId>("bogus"))).rejects.toThrow(
      PersonaNotFoundError,
    );
    await expect(service.get({ username: "user2" }, p.id)).rejects.toThrow(PersonaNotFoundError);
  });

  test("update: mutates persona in place", async () => {
    const db = await freshDb();
    const service = createPersonaService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });

    const p = await service.create({ username: "user" }, { name: "N1", description: "D1" });

    const updated = await service.update({ username: "user" }, p.id, {
      name: "N2",
    });

    expect(updated.name).toBe("N2");
    expect(updated.description).toBe("D1");
  });

  test("remove: deletes persona", async () => {
    const db = await freshDb();
    const service = createPersonaService(db);
    await db.insert(users).values({ id: "u1", handle: "user", createdAt: 1 });

    const p = await service.create({ username: "user" }, { name: "N1", description: "D1" });

    const res = await service.remove({ username: "user" }, p.id);
    expect(res.deleted).toBe(true);

    await expect(service.get({ username: "user" }, p.id)).rejects.toThrow(PersonaNotFoundError);
  });
});
