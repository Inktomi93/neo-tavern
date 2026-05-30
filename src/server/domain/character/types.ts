import type { AssetId, CharacterId, CharacterVersionId } from "../../../shared/ids";
import { DomainNotFoundError, DomainOperationError } from "../_shared/errors";

export class CharacterNotFoundError extends DomainNotFoundError {
  public characterId: CharacterId;
  constructor(characterId: CharacterId) {
    super("Character", characterId);
    this.characterId = characterId;
  }
}

export class CharacterOperationError extends DomainOperationError {
  declare readonly code: "character_in_use" | "handle_conflict";
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

// UpdateCharacterInput is CreateCharacterInput with every field optional, plus the
// identity-only fields that are not part of the versioned card (handle, starred, archived).
export type UpdateCharacterInput = Partial<CreateCharacterInput> & {
  handle?: string;
  starred?: boolean;
  archived?: boolean;
};

export interface CharacterDetail {
  id: CharacterId;
  handle: string;
  currentVersionId: CharacterVersionId | null;
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
  avatarAssetId: AssetId | null;
  avatarHash: string | null;
}

export interface CharacterSummary {
  id: CharacterId;
  handle: string;
  name: string | null;
  description: string | null;
  avatarAssetId: AssetId | null;
  avatarHash: string | null;
  currentVersionId: CharacterVersionId | null;
  version: number | null;
  starred: boolean;
  archived: boolean;
  createdAt: number;
}

export interface CharacterService {
  create(owner: { username: string }, input: CreateCharacterInput): Promise<CharacterDetail>;
  list(owner: { username: string }): Promise<CharacterSummary[]>;
  get(owner: { username: string }, characterId: CharacterId): Promise<CharacterDetail>;
  update(
    owner: { username: string },
    characterId: CharacterId,
    input: UpdateCharacterInput,
  ): Promise<CharacterDetail>;
  remove(owner: { username: string }, characterId: CharacterId): Promise<{ deleted: boolean }>;
}
