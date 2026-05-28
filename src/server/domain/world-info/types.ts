export interface WorldBookView {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
}

export interface WorldEntryView {
  id: string;
  worldBookId: string;
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
  metadata?: unknown | undefined;
}

export interface UpdateWorldEntryInput {
  title?: string | undefined;
  content?: string | undefined;
  legacyKeys?: string[] | undefined;
  enabled?: boolean | undefined;
  priority?: number | undefined;
  metadata?: unknown | undefined;
}

export interface WorldInfoService {
  listBooks(params: { username: string }): Promise<WorldBookView[]>;
  getBook(params: { username: string }, bookId: string): Promise<WorldBookView>;
  createBook(params: { username: string }, input: CreateWorldBookInput): Promise<{ id: string }>;
  updateBook(
    params: { username: string },
    bookId: string,
    input: UpdateWorldBookInput,
  ): Promise<WorldBookView>;
  removeBook(params: { username: string }, bookId: string): Promise<{ deleted: boolean }>;

  listEntries(params: { username: string }, bookId: string): Promise<WorldEntryView[]>;
  getEntry(params: { username: string }, entryId: string): Promise<WorldEntryView>;
  createEntry(
    params: { username: string },
    bookId: string,
    input: CreateWorldEntryInput,
  ): Promise<{ id: string }>;
  updateEntry(
    params: { username: string },
    entryId: string,
    input: UpdateWorldEntryInput,
  ): Promise<WorldEntryView>;
  removeEntry(params: { username: string }, entryId: string): Promise<{ deleted: boolean }>;
}

export class WorldInfoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldInfoNotFoundError";
  }
}
