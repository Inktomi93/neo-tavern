import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { worldBooks, worldEntries } from "../../../db/schema";
import { fetchOwned, stripUndefined } from "../_shared/helpers";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import {
  type CreateWorldBookInput,
  type CreateWorldEntryInput,
  type UpdateWorldBookInput,
  type UpdateWorldEntryInput,
  type WorldBookView,
  type WorldEntryView,
  WorldInfoNotFoundError,
  type WorldInfoService,
} from "./types";

export function createWorldInfoService(db: Db): WorldInfoService {
  async function listBooks(params: { username: string }): Promise<WorldBookView[]> {
    const ownerId = await ensureUser(db, params.username);
    const rows = await db
      .select()
      .from(worldBooks)
      .where(eq(worldBooks.ownerId, ownerId))
      .orderBy(desc(worldBooks.createdAt));
    return rows;
  }

  async function getBook(params: { username: string }, bookId: string): Promise<WorldBookView> {
    const ownerId = await ensureUser(db, params.username);
    const book = await fetchOwned<WorldBookView>(db, worldBooks, bookId, ownerId);
    if (!book) throw new WorldInfoNotFoundError(`book not found: ${bookId}`);
    return book;
  }

  async function createBook(
    params: { username: string },
    input: CreateWorldBookInput,
  ): Promise<{ id: string }> {
    const ownerId = await ensureUser(db, params.username);
    const id = newId();
    await db.insert(worldBooks).values({
      id,
      ownerId,
      name: input.name,
      description: input.description ?? null,
      createdAt: Date.now(),
    });
    return { id };
  }

  async function updateBook(
    params: { username: string },
    bookId: string,
    input: UpdateWorldBookInput,
  ): Promise<WorldBookView> {
    const ownerId = await ensureUser(db, params.username);
    await getBook({ username: params.username }, bookId);

    const updates = stripUndefined(input);

    if (Object.keys(updates).length > 0) {
      await db
        .update(worldBooks)
        .set(updates)
        .where(and(eq(worldBooks.id, bookId), eq(worldBooks.ownerId, ownerId)));
    }
    return getBook({ username: params.username }, bookId);
  }

  async function removeBook(
    params: { username: string },
    bookId: string,
  ): Promise<{ deleted: boolean }> {
    const ownerId = await ensureUser(db, params.username);
    await getBook({ username: params.username }, bookId);
    await db
      .delete(worldBooks)
      .where(and(eq(worldBooks.id, bookId), eq(worldBooks.ownerId, ownerId)));
    return { deleted: true };
  }

  async function listEntries(
    params: { username: string },
    bookId: string,
  ): Promise<WorldEntryView[]> {
    await getBook({ username: params.username }, bookId);
    const rows = await db
      .select()
      .from(worldEntries)
      .where(eq(worldEntries.worldBookId, bookId))
      .orderBy(desc(worldEntries.priority)); // Higher priority first
    return rows.map((r) => ({
      ...r,
      legacyKeys: (r.legacyKeys as string[] | null) ?? null,
      enabled: r.enabled ?? true,
      priority: r.priority ?? 0,
    }));
  }

  async function getEntry(params: { username: string }, entryId: string): Promise<WorldEntryView> {
    const ownerId = await ensureUser(db, params.username);

    // Verify ownership by joining through worldBooks
    const rows = await db
      .select({ entry: worldEntries })
      .from(worldEntries)
      .innerJoin(worldBooks, eq(worldEntries.worldBookId, worldBooks.id))
      .where(and(eq(worldEntries.id, entryId), eq(worldBooks.ownerId, ownerId)));

    const row = rows[0]?.entry;
    if (!row) throw new WorldInfoNotFoundError(`entry not found: ${entryId}`);

    return {
      ...row,
      legacyKeys: (row.legacyKeys as string[] | null) ?? null,
      enabled: row.enabled ?? true,
      priority: row.priority ?? 0,
    };
  }

  async function createEntry(
    params: { username: string },
    bookId: string,
    input: CreateWorldEntryInput,
  ): Promise<{ id: string }> {
    await getBook({ username: params.username }, bookId);
    const id = newId();
    await db.insert(worldEntries).values({
      id,
      worldBookId: bookId,
      title: input.title,
      content: input.content,
      legacyKeys: input.legacyKeys ?? null,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 0,
      metadata: input.metadata ?? null,
    });
    return { id };
  }

  async function updateEntry(
    params: { username: string },
    entryId: string,
    input: UpdateWorldEntryInput,
  ): Promise<WorldEntryView> {
    await getEntry({ username: params.username }, entryId);

    const updates = stripUndefined(input);

    if (Object.keys(updates).length > 0) {
      await db.update(worldEntries).set(updates).where(eq(worldEntries.id, entryId));
    }
    return getEntry({ username: params.username }, entryId);
  }

  async function removeEntry(
    params: { username: string },
    entryId: string,
  ): Promise<{ deleted: boolean }> {
    await getEntry({ username: params.username }, entryId);
    await db.delete(worldEntries).where(eq(worldEntries.id, entryId));
    return { deleted: true };
  }

  return {
    listBooks,
    getBook,
    createBook,
    updateBook,
    removeBook,
    listEntries,
    getEntry,
    createEntry,
    updateEntry,
    removeEntry,
  };
}
