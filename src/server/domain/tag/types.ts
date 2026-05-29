import { DomainNotFoundError } from "../_shared/errors";

export interface TagView {
  id: string;
  name: string;
  color: string | null;
  source: "manual" | "auto" | null;
}

export interface CreateTagInput {
  name: string;
  color?: string | undefined;
  source?: "manual" | "auto" | undefined;
}

export interface UpdateTagInput {
  name?: string | undefined;
  color?: string | undefined;
  source?: "manual" | "auto" | undefined;
}

export interface TagService {
  listTags(params: { username: string }): Promise<TagView[]>;
  getTag(params: { username: string }, tagId: string): Promise<TagView>;
  createTag(params: { username: string }, input: CreateTagInput): Promise<TagView>;
  updateTag(params: { username: string }, tagId: string, input: UpdateTagInput): Promise<TagView>;
  removeTag(params: { username: string }, tagId: string): Promise<{ deleted: boolean }>;

  attachTag(
    params: { username: string },
    tagId: string,
    targetType: "character" | "chat" | "worldBook" | "persona" | "preset",
    targetId: string,
  ): Promise<void>;
  detachTag(
    params: { username: string },
    tagId: string,
    targetType: "character" | "chat" | "worldBook" | "persona" | "preset",
    targetId: string,
  ): Promise<void>;
}

export class TagNotFoundError extends DomainNotFoundError {
  constructor(message: string) {
    // We pass message as ID and "Tag" as entity to fit DomainNotFoundError
    super("Tag", message);
  }
}
