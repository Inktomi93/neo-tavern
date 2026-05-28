// Simple CRUD for personas. No versions needed.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { auditLogs, personas } from "../../../db/schema";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import { type PersonaDetail, PersonaNotFoundError, type PersonaService } from "./types";

type PersonaRow = typeof personas.$inferSelect;

export function createPersonaService(db: Db): PersonaService {
  const log = getLog();

  async function ownedPersona(ownerId: string, personaId: string): Promise<PersonaRow | undefined> {
    return (
      await db
        .select()
        .from(personas)
        .where(and(eq(personas.id, personaId), eq(personas.ownerId, ownerId)))
        .limit(1)
    )[0];
  }

  function detailOf(row: PersonaRow): PersonaDetail {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      avatarAssetId: row.avatarAssetId,
      metadata: row.metadata,
      createdAt: row.createdAt,
    };
  }

  return {
    async create({ username }, input) {
      const ownerId = await ensureUser(db, username);
      const now = Date.now();
      const personaId = newId();

      await db.insert(personas).values({
        id: personaId,
        ownerId,
        name: input.name,
        description: input.description,
        avatarAssetId: input.avatarAssetId,
        metadata: input.metadata,
        createdAt: now,
      });

      await db.insert(auditLogs).values({
        id: newId(),
        timestamp: now,
        action: "CREATE_PERSONA",
        domain: "persona",
        entityId: personaId,
        details: { name: input.name },
      });

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

      const edits: Partial<typeof personas.$inferInsert> = {};
      if (input.name !== undefined) edits.name = input.name;
      if (input.description !== undefined) edits.description = input.description;
      if (input.avatarAssetId !== undefined) edits.avatarAssetId = input.avatarAssetId;
      if (input.metadata !== undefined) edits.metadata = input.metadata;

      if (Object.keys(edits).length > 0) {
        await db.update(personas).set(edits).where(eq(personas.id, personaId));
        await db.insert(auditLogs).values({
          id: newId(),
          timestamp: Date.now(),
          action: "UPDATE_PERSONA",
          domain: "persona",
          entityId: personaId,
          details: edits,
        });
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

      await db.insert(auditLogs).values({
        id: newId(),
        timestamp: Date.now(),
        action: "DELETE_PERSONA",
        domain: "persona",
        entityId: personaId,
        details: {},
      });

      log.info({ personaId }, "persona: deleted");
      return { deleted: true };
    },
  };
}
