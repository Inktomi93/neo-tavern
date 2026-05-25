import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { personas, users } from "../../src/db/schema";
import { freshDb } from "../support/db";

// Wiring smoke test (NOT a schema tautology): proves the migration applies, a row
// round-trips, and the foreign_keys PRAGMA actually took effect.
test("migrations apply and a user round-trips", async () => {
  const db = await freshDb();

  await db.insert(users).values({ id: "u1", handle: "owner", createdAt: Date.now() });
  const rows = await db.select().from(users).where(eq(users.handle, "owner"));

  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe("u1");
});

test("foreign_keys PRAGMA is enforced (the load-bearing one)", async () => {
  const db = await freshDb();

  // personas.ownerId references users.id — a dangling owner must be rejected. If this
  // passes, PRAGMA foreign_keys = ON did NOT take effect.
  await expect(
    db
      .insert(personas)
      .values({ id: "p1", ownerId: "ghost", name: "x", description: "y", createdAt: Date.now() }),
  ).rejects.toThrow();
});
