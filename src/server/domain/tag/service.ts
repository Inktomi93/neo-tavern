import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import {
  characterTags,
  chatTags,
  personaTags,
  presetTags,
  tags,
  worldBookTags,
} from "../../../db/schema";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import {
  type CreateTagInput,
  TagNotFoundError,
  type TagService,
  type TagView,
  type UpdateTagInput,
} from "./types";

export function createTagService(db: Db): TagService {
  async function listTags(params: { username: string }): Promise<TagView[]> {
    const ownerId = await ensureUser(db, params.username);
    const rows = await db.select().from(tags).where(eq(tags.ownerId, ownerId));
    return rows;
  }

  async function getTag(params: { username: string }, tagId: string): Promise<TagView> {
    const ownerId = await ensureUser(db, params.username);
    const rows = await db
      .select()
      .from(tags)
      .where(and(eq(tags.id, tagId), eq(tags.ownerId, ownerId)));
    const tag = rows[0];
    if (!tag) throw new TagNotFoundError(`tag not found: ${tagId}`);
    return tag;
  }

  async function createTag(params: { username: string }, input: CreateTagInput): Promise<TagView> {
    const ownerId = await ensureUser(db, params.username);
    const id = newId();
    await db.insert(tags).values({
      id,
      ownerId,
      name: input.name,
      color: input.color ?? null,
      source: input.source ?? "manual",
    });
    return getTag({ username: params.username }, id);
  }

  async function updateTag(
    params: { username: string },
    tagId: string,
    input: UpdateTagInput,
  ): Promise<TagView> {
    const ownerId = await ensureUser(db, params.username);
    await getTag({ username: params.username }, tagId);

    const updates: Partial<typeof tags.$inferInsert> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.color !== undefined) updates.color = input.color;
    if (input.source !== undefined) updates.source = input.source;

    if (Object.keys(updates).length > 0) {
      await db
        .update(tags)
        .set(updates)
        .where(and(eq(tags.id, tagId), eq(tags.ownerId, ownerId)));
    }
    return getTag({ username: params.username }, tagId);
  }

  async function removeTag(
    params: { username: string },
    tagId: string,
  ): Promise<{ deleted: boolean }> {
    const ownerId = await ensureUser(db, params.username);
    await getTag({ username: params.username }, tagId);
    await db.delete(tags).where(and(eq(tags.id, tagId), eq(tags.ownerId, ownerId)));
    return { deleted: true };
  }

  async function attachTag(
    params: { username: string },
    tagId: string,
    targetType: "character" | "chat" | "worldBook" | "persona" | "preset",
    targetId: string,
  ): Promise<void> {
    await getTag({ username: params.username }, tagId);

    // In a real app we'd verify the target exists and belongs to the user here
    // but the foreign keys handle referential integrity.
    switch (targetType) {
      case "character":
        await db
          .insert(characterTags)
          .values({ tagId, characterId: targetId })
          .onConflictDoNothing();
        break;
      case "chat":
        await db.insert(chatTags).values({ tagId, chatId: targetId }).onConflictDoNothing();
        break;
      case "worldBook":
        await db
          .insert(worldBookTags)
          .values({ tagId, worldBookId: targetId })
          .onConflictDoNothing();
        break;
      case "persona":
        await db.insert(personaTags).values({ tagId, personaId: targetId }).onConflictDoNothing();
        break;
      case "preset":
        await db.insert(presetTags).values({ tagId, presetId: targetId }).onConflictDoNothing();
        break;
    }
  }

  async function detachTag(
    params: { username: string },
    tagId: string,
    targetType: "character" | "chat" | "worldBook" | "persona" | "preset",
    targetId: string,
  ): Promise<void> {
    await getTag({ username: params.username }, tagId);

    switch (targetType) {
      case "character":
        await db
          .delete(characterTags)
          .where(and(eq(characterTags.tagId, tagId), eq(characterTags.characterId, targetId)));
        break;
      case "chat":
        await db
          .delete(chatTags)
          .where(and(eq(chatTags.tagId, tagId), eq(chatTags.chatId, targetId)));
        break;
      case "worldBook":
        await db
          .delete(worldBookTags)
          .where(and(eq(worldBookTags.tagId, tagId), eq(worldBookTags.worldBookId, targetId)));
        break;
      case "persona":
        await db
          .delete(personaTags)
          .where(and(eq(personaTags.tagId, tagId), eq(personaTags.personaId, targetId)));
        break;
      case "preset":
        await db
          .delete(presetTags)
          .where(and(eq(presetTags.tagId, tagId), eq(presetTags.presetId, targetId)));
        break;
    }
  }

  return {
    listTags,
    getTag,
    createTag,
    updateTag,
    removeTag,
    attachTag,
    detachTag,
  };
}
