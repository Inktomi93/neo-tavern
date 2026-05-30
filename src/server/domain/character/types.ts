import { z } from "zod";
import {
  type AssetId,
  brandedId,
  type CharacterId,
  type CharacterVersionId,
} from "../../../shared/ids";
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

// The create-input contract IS the Zod schema — the tRPC router validates against it and the
// domain type is derived from it (z.infer), so the post-validation shape and the service signature
// can never drift apart (no `as CreateCharacterInput` cast at the router seam).
export const createCharacterSchema = z.object({
  handle: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(100000),
  personality: z.string().nullable().optional(),
  scenario: z.string().nullable().optional(),
  greetings: z.array(z.string()).nullable().optional(),
  exampleMessages: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  postHistoryInstructions: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  creatorNotes: z.string().nullable().optional(),
  avatarAssetId: brandedId<AssetId>().nullable().optional(),
});
export type CreateCharacterInput = z.infer<typeof createCharacterSchema>;

// UpdateCharacterInput is CreateCharacterInput with every field optional, plus the identity-only
// fields that are not part of the versioned card (starred, archived). The router extends this with
// the branded `characterId` input.
export const updateCharacterSchema = createCharacterSchema.partial().extend({
  starred: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type UpdateCharacterInput = z.infer<typeof updateCharacterSchema>;

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
