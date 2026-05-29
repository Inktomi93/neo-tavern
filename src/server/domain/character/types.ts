import { DomainNotFoundError, DomainOperationError } from "../_shared/errors";

export class CharacterNotFoundError extends DomainNotFoundError {
  public characterId: string;
  constructor(characterId: string) {
    super("Character", characterId);
    this.characterId = characterId;
  }
}

export class CharacterOperationError extends DomainOperationError {
  declare readonly code: "character_in_use" | "handle_conflict";
  constructor(code: "character_in_use" | "handle_conflict", message: string) {
    super(code, message);
  }
}

export interface CreateCharacterInput {
  handle: string;
  name: string;
  description: string;
  personality?: string | null;
  scenario?: string | null;
  greetings?: string[] | null;
  exampleMessages?: string | null;
  systemPrompt?: string | null;
  postHistoryInstructions?: string | null;
  tags?: string[] | null;
  creatorNotes?: string | null;
  avatarAssetId?: string | null;
}

export interface UpdateCharacterInput {
  handle?: string;
  name?: string;
  description?: string;
  personality?: string | null;
  scenario?: string | null;
  greetings?: string[] | null;
  exampleMessages?: string | null;
  systemPrompt?: string | null;
  postHistoryInstructions?: string | null;
  tags?: string[] | null;
  creatorNotes?: string | null;
  avatarAssetId?: string | null;
  starred?: boolean;
  archived?: boolean;
}

export interface CharacterDetail {
  id: string;
  handle: string;
  currentVersionId: string | null;
  starred: boolean;
  archived: boolean;
  createdAt: number;

  // Pinned flags whether this version is currently used by any chats (copy-on-write check).
  pinned: boolean;

  // Flattened active version data
  version: number | null;
  name: string | null;
  description: string | null;
  personality: string | null;
  scenario: string | null;
  greetings: string[] | null;
  exampleMessages: string | null;
  systemPrompt: string | null;
  postHistoryInstructions: string | null;
  tags: string[] | null;
  creatorNotes: string | null;
  avatarAssetId: string | null;
  avatarHash: string | null;
}

export interface CharacterSummary {
  id: string;
  handle: string;
  name: string | null;
  description: string | null;
  avatarAssetId: string | null;
  avatarHash: string | null;
  currentVersionId: string | null;
  version: number | null;
  starred: boolean;
  archived: boolean;
  createdAt: number;
}

export interface CharacterService {
  create(owner: { username: string }, input: CreateCharacterInput): Promise<CharacterDetail>;
  list(owner: { username: string }): Promise<CharacterSummary[]>;
  get(owner: { username: string }, characterId: string): Promise<CharacterDetail>;
  update(
    owner: { username: string },
    characterId: string,
    input: UpdateCharacterInput,
  ): Promise<CharacterDetail>;
  remove(owner: { username: string }, characterId: string): Promise<{ deleted: boolean }>;
}
