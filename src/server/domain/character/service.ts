// Character CRUD over the characters / character_versions triad — copy-on-write, mirroring preset
// versioning. Editing the current version's content mutates it in place when no chat pins it, else
// forks a new version + repoints currentVersionId — so chats.characterVersionId stays immutable
// provenance. Identity edits (handle/starred/archived) are always in place.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { parseStringArray } from "../../../db/parsers";
import { characters, characterVersions, chats } from "../../../db/schema";
import {
  type AssetId,
  type CharacterId,
  type CharacterVersionId,
  castId,
} from "../../../shared/ids";
import { getLog } from "../../observability/logger";
import { fetchOwned, stripUndefined } from "../_shared/helpers";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import {
  type CharacterDetail,
  CharacterNotFoundError,
  CharacterOperationError,
  type CharacterService,
} from "./types";

type CharacterRow = typeof characters.$inferSelect;

export function createCharacterService(db: Db): CharacterService {
  const log = getLog();

  // Owner-scoped fetch of the identity row.
  async function ownedCharacter(
    ownerId: string,
    characterId: CharacterId,
  ): Promise<CharacterRow | undefined> {
    return fetchOwned(db, characters, characterId, ownerId);
  }

  // Throw CharacterOperationError if `handle` is already taken by another character owned by ownerId.
  async function checkHandleConflict(ownerId: string, handle: string): Promise<void> {
    const existing = await db
      .select({ id: characters.id })
      .from(characters)
      .where(and(eq(characters.handle, handle), eq(characters.ownerId, ownerId)))
      .limit(1);
    if (existing.length > 0) {
      throw new CharacterOperationError("handle_conflict", `handle '${handle}' already in use`);
    }
  }

  // A version is "pinned" once a chat records it as its characterVersionId.
  // Private read helper — takes the raw column string (callers pass row values); branding it would
  // only force casts at internal call sites with no safety gain.
  async function versionPinned(versionId: string): Promise<boolean> {
    const byChat = await db.query.chats.findFirst({
      columns: { id: true },
      where: eq(chats.characterVersionId, versionId),
    });
    return byChat !== undefined;
  }

  // Build the detail view (identity + current version content + pinned flag).
  async function detailOf(character: CharacterRow): Promise<CharacterDetail> {
    const current =
      character.currentVersionId === null
        ? undefined
        : await db.query.characterVersions.findFirst({
            where: eq(characterVersions.id, character.currentVersionId),
            with: { avatar: true },
          });

    return {
      id: castId<CharacterId>(character.id),
      handle: character.handle,
      currentVersionId:
        character.currentVersionId === null
          ? null
          : castId<CharacterVersionId>(character.currentVersionId),
      starred: character.starred ?? false,
      archived: character.archived ?? false,
      createdAt: character.createdAt,

      pinned: current === undefined ? false : await versionPinned(current.id),

      version: current?.version ?? null,
      name: current?.name ?? null,
      description: current?.description ?? null,
      personality: current?.personality ?? null,
      scenario: current?.scenario ?? null,
      greetings: parseStringArray(current?.greetings),
      exampleMessages: current?.exampleMessages ?? null,
      systemPrompt: current?.systemPrompt ?? null,
      postHistoryInstructions: current?.postHistoryInstructions ?? null,
      tags: parseStringArray(current?.tags),
      creatorNotes: current?.creatorNotes ?? null,
      avatarAssetId: current?.avatarAssetId == null ? null : castId<AssetId>(current.avatarAssetId),
      avatarHash: current?.avatar?.hash ?? null,
    };
  }

  return {
    async create({ username }, input) {
      const ownerId = await ensureUser(db, username);
      const now = Date.now();

      // Check for handle conflicts.
      await checkHandleConflict(ownerId, input.handle);

      const characterId = newId<CharacterId>();
      await db.insert(characters).values({
        id: characterId,
        ownerId,
        handle: input.handle,
        createdAt: now,
      });

      const versionId = newId<CharacterVersionId>();
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
      const rows = await db.query.characters.findMany({
        where: eq(characters.ownerId, ownerId),
        orderBy: desc(characters.createdAt),
        with: {
          currentVersion: {
            with: { avatar: true },
          },
        },
      });

      return rows.map((c) => ({
        id: castId<CharacterId>(c.id),
        handle: c.handle,
        name: c.currentVersion?.name ?? null,
        description: c.currentVersion?.description ?? null,
        avatarAssetId:
          c.currentVersion?.avatarAssetId == null
            ? null
            : castId<AssetId>(c.currentVersion.avatarAssetId),
        avatarHash: c.currentVersion?.avatar?.hash ?? null,
        currentVersionId:
          c.currentVersionId === null ? null : castId<CharacterVersionId>(c.currentVersionId),
        version: c.currentVersion?.version ?? null,
        starred: c.starred ?? false,
        archived: c.archived ?? false,
        createdAt: c.createdAt,
      }));
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
      const idEdits = stripUndefined({
        handle: input.handle !== row.handle ? input.handle : undefined,
        starred: input.starred,
        archived: input.archived,
      });

      if (input.handle !== undefined && input.handle !== row.handle) {
        await checkHandleConflict(ownerId, input.handle);
      }

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
          const versionId = newId<CharacterVersionId>();
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

          const versionId = newId<CharacterVersionId>();
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
          const vEdits = stripUndefined({
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
          });

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
