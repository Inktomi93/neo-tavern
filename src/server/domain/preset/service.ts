// Preset CRUD over the presets / preset_versions triad — copy-on-write, mirroring the character
// versioning in domain/import (the reference implementation cited in docs/data-model.md). Editing
// the current version's CONFIG mutates it in place when no chat/message pins it, else forks a new
// version + repoints currentVersionId — so messages.presetVersionId stays immutable provenance.
// Identity edits (name/kind) are always in place. Owner-scoped in this layer (every read/write
// bakes WHERE owner_id = the resolved user), exercised even single-user.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { chats, messages, presets, presetVersions } from "../../../db/schema";
import {
  DEFAULT_PROMPT_CONFIG,
  type PromptConfig,
  parsePromptConfig,
} from "../../../shared/prompt-config";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import {
  type PresetDetail,
  PresetNotFoundError,
  PresetOperationError,
  type PresetService,
  type PresetSummary,
  type UpdatePresetParams,
} from "./types";

type PresetRow = typeof presets.$inferSelect;

export function createPresetService(db: Db): PresetService {
  const log = getLog();

  // Owner-scoped fetch of the identity row (the scoping seam — unowned ⇒ treated as not found).
  async function ownedPreset(ownerId: string, presetId: string): Promise<PresetRow | undefined> {
    return (
      await db
        .select()
        .from(presets)
        .where(and(eq(presets.id, presetId), eq(presets.ownerId, ownerId)))
        .limit(1)
    )[0];
  }

  // A version is "pinned" once a chat or message records it as the basis of a turn — after that it
  // must never mutate (it'd rewrite past provenance), so a config edit forks instead.
  async function versionPinned(versionId: string): Promise<boolean> {
    const byChat = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.presetVersionId, versionId))
      .limit(1);
    if (byChat.length > 0) return true;
    const byMessage = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.presetVersionId, versionId))
      .limit(1);
    return byMessage.length > 0;
  }

  // Build the detail view (identity + the current version's parsed config + pinned flag).
  async function detailOf(preset: PresetRow): Promise<PresetDetail> {
    const current =
      preset.currentVersionId === null
        ? undefined
        : (
            await db
              .select()
              .from(presetVersions)
              .where(eq(presetVersions.id, preset.currentVersionId))
              .limit(1)
          )[0];
    const config: PromptConfig =
      current === undefined ? DEFAULT_PROMPT_CONFIG : parsePromptConfig(current.config);
    return {
      id: preset.id,
      name: preset.name,
      kind: preset.kind,
      currentVersionId: preset.currentVersionId,
      version: current?.version ?? null,
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
      config,
      schemaVersion: config.schemaVersion,
      pinned: current === undefined ? false : await versionPinned(current.id),
    };
  }

  return {
    async create({ username, name, kind, config }) {
      const ownerId = await ensureUser(db, username);
      const now = Date.now();
      const presetId = newId();
      const blob = config ?? DEFAULT_PROMPT_CONFIG;
      await db
        .insert(presets)
        .values({ id: presetId, ownerId, name, kind, createdAt: now, updatedAt: now });
      const versionId = newId();
      await db.insert(presetVersions).values({
        id: versionId,
        presetId,
        version: 1,
        config: blob,
        schemaVersion: blob.schemaVersion,
        createdAt: now,
      });
      await db.update(presets).set({ currentVersionId: versionId }).where(eq(presets.id, presetId));
      log.info({ presetId, kind }, "preset: created");
      const row = await ownedPreset(ownerId, presetId);
      if (row === undefined) throw new PresetNotFoundError(presetId); // unreachable — just inserted
      return detailOf(row);
    },

    async list({ username }) {
      const ownerId = await ensureUser(db, username);
      const rows = await db
        .select()
        .from(presets)
        .where(eq(presets.ownerId, ownerId))
        .orderBy(desc(presets.updatedAt));
      // Resolve each current version's number in one pass (small N — a personal preset library).
      const summaries: PresetSummary[] = [];
      for (const p of rows) {
        const v =
          p.currentVersionId === null
            ? null
            : ((
                await db
                  .select({ version: presetVersions.version })
                  .from(presetVersions)
                  .where(eq(presetVersions.id, p.currentVersionId))
                  .limit(1)
              )[0]?.version ?? null);
        summaries.push({
          id: p.id,
          name: p.name,
          kind: p.kind,
          currentVersionId: p.currentVersionId,
          version: v,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        });
      }
      return summaries;
    },

    async get({ username, presetId }) {
      const ownerId = await ensureUser(db, username);
      const row = await ownedPreset(ownerId, presetId);
      if (row === undefined) throw new PresetNotFoundError(presetId);
      return detailOf(row);
    },

    async update({ username, presetId, name, kind, config }: UpdatePresetParams) {
      const ownerId = await ensureUser(db, username);
      const row = await ownedPreset(ownerId, presetId);
      if (row === undefined) throw new PresetNotFoundError(presetId);
      const now = Date.now();

      // Identity edits (name/kind) — always in place; they're not provenance.
      const idEdits: Partial<Pick<PresetRow, "name" | "kind">> = {};
      if (name !== undefined) idEdits.name = name;
      if (kind !== undefined) idEdits.kind = kind;

      if (config !== undefined) {
        const pinned = row.currentVersionId !== null && (await versionPinned(row.currentVersionId));
        if (row.currentVersionId === null) {
          // No version yet (shouldn't happen via create) — mint v1.
          const versionId = newId();
          await db.insert(presetVersions).values({
            id: versionId,
            presetId,
            version: 1,
            config,
            schemaVersion: config.schemaVersion,
            createdAt: now,
          });
          await db
            .update(presets)
            .set({ ...idEdits, currentVersionId: versionId, updatedAt: now })
            .where(eq(presets.id, presetId));
        } else if (pinned) {
          // Copy-on-write fork: a pinned version is immutable provenance — never mutate it.
          const maxV =
            (
              await db
                .select({ v: presetVersions.version })
                .from(presetVersions)
                .where(eq(presetVersions.presetId, presetId))
                .orderBy(desc(presetVersions.version))
                .limit(1)
            )[0]?.v ?? 0;
          const versionId = newId();
          await db.insert(presetVersions).values({
            id: versionId,
            presetId,
            version: maxV + 1,
            config,
            schemaVersion: config.schemaVersion,
            createdAt: now,
          });
          await db
            .update(presets)
            .set({ ...idEdits, currentVersionId: versionId, updatedAt: now })
            .where(eq(presets.id, presetId));
          log.info({ presetId, version: maxV + 1 }, "preset: forked version (was pinned)");
        } else {
          // Unpinned current version — mutate its config in place (drafts don't spam versions).
          await db
            .update(presetVersions)
            .set({ config, schemaVersion: config.schemaVersion })
            .where(eq(presetVersions.id, row.currentVersionId));
          if (Object.keys(idEdits).length > 0) {
            await db
              .update(presets)
              .set({ ...idEdits, updatedAt: now })
              .where(eq(presets.id, presetId));
          } else {
            await db.update(presets).set({ updatedAt: now }).where(eq(presets.id, presetId));
          }
        }
      } else if (Object.keys(idEdits).length > 0) {
        await db
          .update(presets)
          .set({ ...idEdits, updatedAt: now })
          .where(eq(presets.id, presetId));
      }

      const updated = await ownedPreset(ownerId, presetId);
      if (updated === undefined) throw new PresetNotFoundError(presetId);
      return detailOf(updated);
    },

    async remove({ username, presetId }) {
      const ownerId = await ensureUser(db, username);
      const row = await ownedPreset(ownerId, presetId);
      if (row === undefined) throw new PresetNotFoundError(presetId);

      // Refuse if ANY version is pinned (the RESTRICT FK would fail the cascade anyway — pre-check
      // for a clean domain error). Archive-don't-delete, like characters.
      const versionIds = (
        await db
          .select({ id: presetVersions.id })
          .from(presetVersions)
          .where(eq(presetVersions.presetId, presetId))
      ).map((v) => v.id);
      for (const vid of versionIds) {
        if (await versionPinned(vid)) {
          throw new PresetOperationError(
            "preset_in_use",
            `preset ${presetId} has a version pinned by a chat/message — cannot delete`,
          );
        }
      }
      // Break the circular currentVersionId pointer, then delete (versions cascade with the preset).
      await db.update(presets).set({ currentVersionId: null }).where(eq(presets.id, presetId));
      await db.delete(presets).where(eq(presets.id, presetId));
      log.info({ presetId }, "preset: deleted");
      return { deleted: true };
    },
  };
}
