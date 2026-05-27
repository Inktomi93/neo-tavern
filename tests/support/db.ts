import { eq } from "drizzle-orm";
import { createDb, type Db, runMigrations } from "../../src/db/client";
import { characters, characterVersions, users } from "../../src/db/schema";

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
  },
): Promise<{ characterId: string; ownerId: string; characterVersionId: string }> {
  const now = Date.now();
  const cvId = `${opts.id}-v1`;
  await db
    .insert(users)
    .values({ id: opts.ownerId, handle: opts.ownerId, createdAt: now })
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
    createdAt: now,
  });
  await db.update(characters).set({ currentVersionId: cvId }).where(eq(characters.id, opts.id));
  return { characterId: opts.id, ownerId: opts.ownerId, characterVersionId: cvId };
}
