import { z } from "zod";
import { type AssetId, brandedId, type PersonaId } from "../../../shared/ids";
import { DomainNotFoundError } from "../_shared/errors";

export class PersonaNotFoundError extends DomainNotFoundError {
  public personaId: PersonaId;
  constructor(personaId: PersonaId) {
    super("Persona", personaId);
    this.personaId = personaId;
  }
}

// The create-input contract IS the Zod schema; the domain type is derived (z.infer) so the router's
// validated shape and the service signature stay locked together (no post-validation cast). metadata
// is constrained to a JSON object rather than the old `z.any()` free-for-all.
export const createPersonaSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(100000),
  avatarAssetId: brandedId<AssetId>().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type CreatePersonaInput = z.infer<typeof createPersonaSchema>;

export const updatePersonaSchema = createPersonaSchema.partial();
export type UpdatePersonaInput = z.infer<typeof updatePersonaSchema>;

export interface PersonaDetail {
  id: PersonaId;
  name: string;
  description: string;
  avatarAssetId: AssetId | null;
  metadata: unknown | null;
  createdAt: number;
}

export interface PersonaService {
  create(owner: { username: string }, input: CreatePersonaInput): Promise<PersonaDetail>;
  list(owner: { username: string }): Promise<PersonaDetail[]>;
  get(owner: { username: string }, personaId: PersonaId): Promise<PersonaDetail>;
  update(
    owner: { username: string },
    personaId: PersonaId,
    input: UpdatePersonaInput,
  ): Promise<PersonaDetail>;
  remove(owner: { username: string }, personaId: PersonaId): Promise<{ deleted: boolean }>;
}
