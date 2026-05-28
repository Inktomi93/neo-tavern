// Character CRUD over the characters / character_versions triad — copy-on-write, mirroring preset
// versioning. Editing the current version's content mutates it in place when no chat pins it, else
// forks a new version + repoints currentVersionId — so chats.characterVersionId stays immutable
// provenance. Identity edits (handle/starred/archived) are always in place.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { assets, characters, characterVersions, chats } from "../../../db/schema";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import {
  type CharacterDetail,
  CharacterNotFoundError,
  CharacterOperationError,
  type CharacterService,
  type CharacterSummary,
} from "./types";

type CharacterRow = typeof characters.$inferSelect;

export function createCharacterService(db: Db): CharacterService {
  const log = getLog();

  // Owner-scoped fetch of the identity row.
  async function ownedCharacter(
    ownerId: string,
    characterId: string,
  ): Promise<CharacterRow | undefined> {
    return (
      await db
        .select()
        .from(characters)
        .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
        .limit(1)
    )[0];
  }

  // A version is "pinned" once a chat records it as its characterVersionId.
  async function versionPinned(versionId: string): Promise<boolean> {
    const byChat = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.characterVersionId, versionId))
      .limit(1);
    return byChat.length > 0;
  }

  // Build the detail view (identity + current version content + pinned flag).
  async function detailOf(character: CharacterRow): Promise<CharacterDetail> {
    const current =
      character.currentVersionId === null
        ? undefined
        : (
            await db
              .select({
                cv: characterVersions,
                hash: assets.hash,
              })
              .from(characterVersions)
              .leftJoin(assets, eq(assets.id, characterVersions.avatarAssetId))
              .where(eq(characterVersions.id, character.currentVersionId))
              .limit(1)
          )[0];

    return {
      id: character.id,
      handle: character.handle,
      currentVersionId: character.currentVersionId,
      starred: character.starred ?? false,
      archived: character.archived ?? false,
      createdAt: character.createdAt,

      pinned: current === undefined ? false : await versionPinned(current.cv.id),

      version: current?.cv.version ?? null,
      name: current?.cv.name ?? null,
      description: current?.cv.description ?? null,
      personality: current?.cv.personality ?? null,
      scenario: current?.cv.scenario ?? null,
      greetings: (current?.cv.greetings as string[]) ?? null,
      exampleMessages: current?.cv.exampleMessages ?? null,
      systemPrompt: current?.cv.systemPrompt ?? null,
      postHistoryInstructions: current?.cv.postHistoryInstructions ?? null,
      tags: (current?.cv.tags as string[]) ?? null,
      creatorNotes: current?.cv.creatorNotes ?? null,
      avatarAssetId: current?.cv.avatarAssetId ?? null,
      avatarHash: current?.hash ?? null,
    };
  }

  return {
    async create({ username }, input) {
      const ownerId = await ensureUser(db, username);
      const now = Date.now();

      // Check for handle conflicts.
      const existing = await db
        .select({ id: characters.id })
        .from(characters)
        .where(and(eq(characters.handle, input.handle), eq(characters.ownerId, ownerId)))
        .limit(1);

      if (existing.length > 0) {
        throw new CharacterOperationError(
          "handle_conflict",
          `handle '${input.handle}' already in use`,
        );
      }

      const characterId = newId();
      await db.insert(characters).values({
        id: characterId,
        ownerId,
        handle: input.handle,
        createdAt: now,
      });

      const versionId = newId();
      await db.insert(characterVersions).values({
        id: versionId,
        characterId,
        version: 1,
        name: input.name,
        description: input.description,
        personality: input.personality,
        scenario: input.scenario,
        greetings: input.greetings,
        exampleMessages: input.exampleMessages,
        systemPrompt: input.systemPrompt,
        postHistoryInstructions: input.postHistoryInstructions,
        tags: input.tags,
        creatorNotes: input.creatorNotes,
        avatarAssetId: input.avatarAssetId,
        createdAt: now,
      });

      await db
        .update(characters)
        .set({ currentVersionId: versionId })
        .where(eq(characters.id, characterId));

      log.info({ characterId, handle: input.handle }, "character: created");

      const row = await ownedCharacter(ownerId, characterId);
      if (row === undefined) throw new CharacterNotFoundError(characterId);
      return detailOf(row);
    },

    async list({ username }) {
      const ownerId = await ensureUser(db, username);
      const rows = await db
        .select()
        .from(characters)
        .where(eq(characters.ownerId, ownerId))
        .orderBy(desc(characters.createdAt));

      const summaries: CharacterSummary[] = [];
      for (const c of rows) {
        let v: number | null = null;
        let name: string | null = null;
        let descText: string | null = null;
        let avatarAssetId: string | null = null;
        let avatarHash: string | null = null;

        if (c.currentVersionId !== null) {
          const cv = (
            await db
              .select({
                version: characterVersions.version,
                name: characterVersions.name,
                description: characterVersions.description,
                avatarAssetId: characterVersions.avatarAssetId,
                avatarHash: assets.hash,
              })
              .from(characterVersions)
              .leftJoin(assets, eq(assets.id, characterVersions.avatarAssetId))
              .where(eq(characterVersions.id, c.currentVersionId))
              .limit(1)
          )[0];
          if (cv) {
            v = cv.version;
            name = cv.name;
            descText = cv.description;
            avatarAssetId = cv.avatarAssetId;
            avatarHash = cv.avatarHash;
          }
        }

        summaries.push({
          id: c.id,
          handle: c.handle,
          name,
          description: descText,
          avatarAssetId,
          avatarHash,
          currentVersionId: c.currentVersionId,
          version: v,
          starred: c.starred ?? false,
          archived: c.archived ?? false,
          createdAt: c.createdAt,
        });
      }
      return summaries;
    },

    async get({ username }, characterId) {
      const ownerId = await ensureUser(db, username);
      const row = await ownedCharacter(ownerId, characterId);
      if (row === undefined) throw new CharacterNotFoundError(characterId);
      return detailOf(row);
    },

    async update({ username }, characterId, input) {
      const ownerId = await ensureUser(db, username);
      const row = await ownedCharacter(ownerId, characterId);
      if (row === undefined) throw new CharacterNotFoundError(characterId);
      const now = Date.now();

      // Identity edits (handle/starred/archived) — always in place.
      const idEdits: Partial<Pick<CharacterRow, "handle" | "starred" | "archived">> = {};
      if (input.handle !== undefined) {
        if (input.handle !== row.handle) {
          const existing = await db
            .select({ id: characters.id })
            .from(characters)
            .where(and(eq(characters.handle, input.handle), eq(characters.ownerId, ownerId)))
            .limit(1);
          if (existing.length > 0) {
            throw new CharacterOperationError(
              "handle_conflict",
              `handle '${input.handle}' already in use`,
            );
          }
        }
        idEdits.handle = input.handle;
      }
      if (input.starred !== undefined) idEdits.starred = input.starred;
      if (input.archived !== undefined) idEdits.archived = input.archived;

      // Extract version fields
      const {
        name,
        description,
        personality,
        scenario,
        greetings,
        exampleMessages,
        systemPrompt,
        postHistoryInstructions,
        tags,
        creatorNotes,
        avatarAssetId,
      } = input;

      const hasVersionEdits = [
        name,
        description,
        personality,
        scenario,
        greetings,
        exampleMessages,
        systemPrompt,
        postHistoryInstructions,
        tags,
        creatorNotes,
        avatarAssetId,
      ].some((v) => v !== undefined);

      if (hasVersionEdits) {
        const pinned = row.currentVersionId !== null && (await versionPinned(row.currentVersionId));

        if (row.currentVersionId === null) {
          // No version yet — mint v1.
          const versionId = newId();
          await db.insert(characterVersions).values({
            id: versionId,
            characterId,
            version: 1,
            name: name ?? "Unknown",
            description: description ?? "",
            personality,
            scenario,
            greetings,
            exampleMessages,
            systemPrompt,
            postHistoryInstructions,
            tags,
            creatorNotes,
            avatarAssetId,
            createdAt: now,
          });
          await db
            .update(characters)
            .set({ ...idEdits, currentVersionId: versionId })
            .where(eq(characters.id, characterId));
        } else if (pinned) {
          // Copy-on-write fork.
          const cvRows = await db
            .select()
            .from(characterVersions)
            .where(eq(characterVersions.characterId, characterId))
            .orderBy(desc(characterVersions.version));

          const maxV = cvRows[0]?.version ?? 0;
          const current = cvRows.find((v) => v.id === row.currentVersionId);
          if (!current) throw new Error("Current version missing");

          const versionId = newId();
          await db.insert(characterVersions).values({
            id: versionId,
            characterId,
            version: maxV + 1,
            name: name ?? current.name,
            description: description ?? current.description,
            personality: personality !== undefined ? personality : current.personality,
            scenario: scenario !== undefined ? scenario : current.scenario,
            greetings: greetings !== undefined ? greetings : current.greetings,
            exampleMessages:
              exampleMessages !== undefined ? exampleMessages : current.exampleMessages,
            systemPrompt: systemPrompt !== undefined ? systemPrompt : current.systemPrompt,
            postHistoryInstructions:
              postHistoryInstructions !== undefined
                ? postHistoryInstructions
                : current.postHistoryInstructions,
            tags: tags !== undefined ? tags : current.tags,
            creatorNotes: creatorNotes !== undefined ? creatorNotes : current.creatorNotes,
            avatarAssetId: avatarAssetId !== undefined ? avatarAssetId : current.avatarAssetId,
            createdAt: now,
          });

          await db
            .update(characters)
            .set({ ...idEdits, currentVersionId: versionId })
            .where(eq(characters.id, characterId));
          log.info({ characterId, version: maxV + 1 }, "character: forked version (was pinned)");
        } else {
          // Unpinned — mutate in place.
          const vEdits: Partial<typeof characterVersions.$inferInsert> = {};
          if (name !== undefined) vEdits.name = name;
          if (description !== undefined) vEdits.description = description;
          if (personality !== undefined) vEdits.personality = personality;
          if (scenario !== undefined) vEdits.scenario = scenario;
          if (greetings !== undefined) vEdits.greetings = greetings;
          if (exampleMessages !== undefined) vEdits.exampleMessages = exampleMessages;
          if (systemPrompt !== undefined) vEdits.systemPrompt = systemPrompt;
          if (postHistoryInstructions !== undefined)
            vEdits.postHistoryInstructions = postHistoryInstructions;
          if (tags !== undefined) vEdits.tags = tags;
          if (creatorNotes !== undefined) vEdits.creatorNotes = creatorNotes;
          if (avatarAssetId !== undefined) vEdits.avatarAssetId = avatarAssetId;

          await db
            .update(characterVersions)
            .set(vEdits)
            .where(eq(characterVersions.id, row.currentVersionId));

          if (Object.keys(idEdits).length > 0) {
            await db.update(characters).set(idEdits).where(eq(characters.id, characterId));
          }
        }
      } else if (Object.keys(idEdits).length > 0) {
        await db.update(characters).set(idEdits).where(eq(characters.id, characterId));
      }

      const updated = await ownedCharacter(ownerId, characterId);
      if (updated === undefined) throw new CharacterNotFoundError(characterId);
      return detailOf(updated);
    },

    async remove({ username }, characterId) {
      const ownerId = await ensureUser(db, username);
      const row = await ownedCharacter(ownerId, characterId);
      if (row === undefined) throw new CharacterNotFoundError(characterId);

      // Refuse if ANY version is pinned by a chat.
      const versionIds = (
        await db
          .select({ id: characterVersions.id })
          .from(characterVersions)
          .where(eq(characterVersions.characterId, characterId))
      ).map((v) => v.id);

      for (const vid of versionIds) {
        if (await versionPinned(vid)) {
          throw new CharacterOperationError(
            "character_in_use",
            `character ${characterId} has a version pinned by a chat — cannot delete. Archive it instead.`,
          );
        }
      }

      // Break pointer, then delete (versions cascade).
      await db
        .update(characters)
        .set({ currentVersionId: null })
        .where(eq(characters.id, characterId));
      await db.delete(characters).where(eq(characters.id, characterId));
      log.info({ characterId }, "character: deleted");
      return { deleted: true };
    },
  };
}
