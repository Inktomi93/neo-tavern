// Simple CRUD for personas. No versions needed.

import { desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { personas } from "../../../db/schema";
import { type AssetId, castId, type PersonaId } from "../../../shared/ids";
import { getLog } from "../../observability/logger";
import { logAudit } from "../_shared/audit";
import { fetchOwned, stripUndefined } from "../_shared/helpers";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import { type PersonaDetail, PersonaNotFoundError, type PersonaService } from "./types";

type PersonaRow = typeof personas.$inferSelect;

export function createPersonaService(db: Db): PersonaService {
  const log = getLog();

  async function ownedPersona(
    ownerId: string,
    personaId: PersonaId,
  ): Promise<PersonaRow | undefined> {
    return fetchOwned(db, personas, personaId, ownerId);
  }

  function detailOf(row: PersonaRow): PersonaDetail {
    return {
      id: castId<PersonaId>(row.id),
      name: row.name,
      description: row.description,
      avatarAssetId: row.avatarAssetId == null ? null : castId<AssetId>(row.avatarAssetId),
      metadata: row.metadata,
      createdAt: row.createdAt,
    };
  }

  return {
    async create({ username }, input) {
      const ownerId = await ensureUser(db, username);
      const now = Date.now();
      const personaId = newId<PersonaId>();

      await db.insert(personas).values({
        id: personaId,
        ownerId,
        name: input.name,
        description: input.description,
        avatarAssetId: input.avatarAssetId,
        metadata: input.metadata,
        createdAt: now,
      });

      await logAudit(db, "CREATE_PERSONA", "persona", personaId, { name: input.name }, now);

      log.info({ personaId }, "persona: created");

      const row = await ownedPersona(ownerId, personaId);
      if (row === undefined) throw new PersonaNotFoundError(personaId);
      return detailOf(row);
    },

    async list({ username }) {
      const ownerId = await ensureUser(db, username);
      const rows = await db
        .select()
        .from(personas)
        .where(eq(personas.ownerId, ownerId))
        .orderBy(desc(personas.createdAt));
      return rows.map(detailOf);
    },

    async get({ username }, personaId) {
      const ownerId = await ensureUser(db, username);
      const row = await ownedPersona(ownerId, personaId);
      if (row === undefined) throw new PersonaNotFoundError(personaId);
      return detailOf(row);
    },

    async update({ username }, personaId, input) {
      const ownerId = await ensureUser(db, username);
      const row = await ownedPersona(ownerId, personaId);
      if (row === undefined) throw new PersonaNotFoundError(personaId);

      const edits = stripUndefined(input);

      if (Object.keys(edits).length > 0) {
        await db.update(personas).set(edits).where(eq(personas.id, personaId));
        await logAudit(db, "UPDATE_PERSONA", "persona", personaId, edits);
      }

      const updated = await ownedPersona(ownerId, personaId);
      if (updated === undefined) throw new PersonaNotFoundError(personaId);
      return detailOf(updated);
    },

    async remove({ username }, personaId) {
      const ownerId = await ensureUser(db, username);
      const row = await ownedPersona(ownerId, personaId);
      if (row === undefined) throw new PersonaNotFoundError(personaId);

      await db.delete(personas).where(eq(personas.id, personaId));

      await logAudit(db, "DELETE_PERSONA", "persona", personaId, {});

      log.info({ personaId }, "persona: deleted");
      return { deleted: true };
    },
  };
}
