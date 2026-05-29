import { DomainNotFoundError } from "../_shared/errors";

export class PersonaNotFoundError extends DomainNotFoundError {
  public personaId: string;
  constructor(personaId: string) {
    super("Persona", personaId);
    this.personaId = personaId;
  }
}

export interface CreatePersonaInput {
  name: string;
  description: string;
  avatarAssetId?: string | null;
  metadata?: unknown | null;
}

export interface UpdatePersonaInput {
  name?: string;
  description?: string;
  avatarAssetId?: string | null;
  metadata?: unknown | null;
}

export interface PersonaDetail {
  id: string;
  name: string;
  description: string;
  avatarAssetId: string | null;
  metadata: unknown | null;
  createdAt: number;
}

export interface PersonaService {
  create(owner: { username: string }, input: CreatePersonaInput): Promise<PersonaDetail>;
  list(owner: { username: string }): Promise<PersonaDetail[]>;
  get(owner: { username: string }, personaId: string): Promise<PersonaDetail>;
  update(
    owner: { username: string },
    personaId: string,
    input: UpdatePersonaInput,
  ): Promise<PersonaDetail>;
  remove(owner: { username: string }, personaId: string): Promise<{ deleted: boolean }>;
}
