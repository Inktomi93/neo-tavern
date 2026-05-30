import type { WorldBookId, WorldEntryId } from "../../../shared/ids";
import { DomainNotFoundError } from "../_shared/errors";

export interface WorldBookView {
  id: WorldBookId;
  name: string;
  description: string | null;
  createdAt: number;
}

export interface WorldEntryView {
  id: WorldEntryId;
  worldBookId: WorldBookId;
  title: string;
  content: string;
  legacyKeys: string[] | null;
  enabled: boolean;
  priority: number;
  metadata: unknown | null;
}

export interface CreateWorldBookInput {
  name: string;
  description?: string | undefined;
}

export interface UpdateWorldBookInput {
  name?: string | undefined;
  description?: string | undefined;
}

export interface CreateWorldEntryInput {
  title: string;
  content: string;
  legacyKeys?: string[] | undefined;
  enabled?: boolean | undefined;
  priority?: number | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

export interface UpdateWorldEntryInput {
  title?: string | undefined;
  content?: string | undefined;
  legacyKeys?: string[] | undefined;
  enabled?: boolean | undefined;
  priority?: number | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

export interface WorldInfoService {
  listBooks(params: { username: string }): Promise<WorldBookView[]>;
  getBook(params: { username: string }, bookId: WorldBookId): Promise<WorldBookView>;
  createBook(
    params: { username: string },
    input: CreateWorldBookInput,
  ): Promise<{ id: WorldBookId }>;
  updateBook(
    params: { username: string },
    bookId: WorldBookId,
    input: UpdateWorldBookInput,
  ): Promise<WorldBookView>;
  removeBook(params: { username: string }, bookId: WorldBookId): Promise<{ deleted: boolean }>;

  listEntries(params: { username: string }, bookId: WorldBookId): Promise<WorldEntryView[]>;
  getEntry(params: { username: string }, entryId: WorldEntryId): Promise<WorldEntryView>;
  createEntry(
    params: { username: string },
    bookId: WorldBookId,
    input: CreateWorldEntryInput,
  ): Promise<{ id: WorldEntryId }>;
  updateEntry(
    params: { username: string },
    entryId: WorldEntryId,
    input: UpdateWorldEntryInput,
  ): Promise<WorldEntryView>;
  removeEntry(params: { username: string }, entryId: WorldEntryId): Promise<{ deleted: boolean }>;
}

export class WorldInfoNotFoundError extends DomainNotFoundError {
  constructor(message: string) {
    // We pass message as ID and "WorldInfo" as entity to fit DomainNotFoundError
    super("WorldInfo", message);
  }
}
