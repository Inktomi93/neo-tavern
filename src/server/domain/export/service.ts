// Export service: read a character / chat from canon and serialize to a downloadable artifact —
// the inverse of domain/import. Character → a V3 card PNG (live fields embedded in the avatar, or a
// placeholder when there's none); chat → SillyTavern JSONL. Owner-scoped. Returns bytes/text; the
// entry layer (app.ts) streams them with a download filename.
import { Buffer } from "node:buffer";
import { and, asc, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import type { Db } from "../../../db/client";
import {
  assets,
  characters,
  characterVersions,
  characterVersionWorldEntries,
  chats,
  messages,
  messageVariants,
  personas,
  worldEntries,
} from "../../../db/schema";
import type { Cas } from "../../storage/cas";
import { buildCardV3, type ExportWorldEntry } from "./card";
import { buildChatJsonl, type ExportMessage } from "./chat";
import { embedCardChunk } from "./png";

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const slug = (s: string): string =>
  s
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "export";

export interface ExportService {
  /** A V3 character-card PNG, or null if the character isn't the owner's / has no version. */
  exportCharacter(
    ownerId: string,
    characterId: string,
  ): Promise<{ bytes: Uint8Array; filename: string } | null>;
  /** SillyTavern chat JSONL, or null if the chat isn't the owner's. */
  exportChat(ownerId: string, chatId: string): Promise<{ text: string; filename: string } | null>;
}

export function createExportService(db: Db, cas: Cas): ExportService {
  // The base PNG to embed the card into: the avatar (transcoded to PNG if needed), else a placeholder.
  async function basePng(avatarAssetId: string | null): Promise<Uint8Array> {
    if (avatarAssetId) {
      const asset = (
        await db
          .select({ hash: assets.hash, mime: assets.mime })
          .from(assets)
          .where(eq(assets.id, avatarAssetId))
          .limit(1)
      )[0];
      if (asset && (await cas.exists(asset.hash))) {
        const raw = await cas.read(asset.hash);
        if (asset.mime === "image/png") return raw;
        return new Uint8Array(await sharp(Buffer.from(raw)).png().toBuffer()); // transcode jpg/webp → png
      }
    }
    return new Uint8Array(
      await sharp({
        create: { width: 256, height: 256, channels: 3, background: { r: 40, g: 40, b: 50 } },
      })
        .png()
        .toBuffer(),
    );
  }

  return {
    async exportCharacter(ownerId, characterId) {
      const charRow = (
        await db
          .select({ currentVersionId: characters.currentVersionId })
          .from(characters)
          .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!charRow?.currentVersionId) return null;

      const v = (
        await db
          .select()
          .from(characterVersions)
          .where(eq(characterVersions.id, charRow.currentVersionId))
          .limit(1)
      )[0];
      if (!v) return null;

      const wi = await db
        .select({
          content: worldEntries.content,
          legacyKeys: worldEntries.legacyKeys,
          enabled: worldEntries.enabled,
          priority: worldEntries.priority,
        })
        .from(characterVersionWorldEntries)
        .innerJoin(worldEntries, eq(characterVersionWorldEntries.entryId, worldEntries.id))
        .where(eq(characterVersionWorldEntries.characterVersionId, v.id));
      const entries: ExportWorldEntry[] = wi.map((e) => ({
        keys: strArr(e.legacyKeys),
        content: e.content,
        enabled: e.enabled ?? true,
        priority: e.priority ?? 0,
      }));

      const card = buildCardV3(
        {
          name: v.name,
          description: v.description,
          personality: v.personality,
          scenario: v.scenario,
          greetings: strArr(v.greetings),
          exampleMessages: v.exampleMessages,
          systemPrompt: v.systemPrompt,
          postHistoryInstructions: v.postHistoryInstructions,
          creatorNotes: v.creatorNotes,
          tags: strArr(v.tags),
        },
        entries,
      );
      const bytes = embedCardChunk(await basePng(v.avatarAssetId), card);
      return { bytes, filename: `${slug(v.name)}.png` };
    },

    async exportChat(ownerId, chatId) {
      const chat = (
        await db
          .select()
          .from(chats)
          .where(and(eq(chats.id, chatId), eq(chats.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!chat) return null;

      const cv = (
        await db
          .select({ name: characterVersions.name })
          .from(characterVersions)
          .where(eq(characterVersions.id, chat.characterVersionId))
          .limit(1)
      )[0];

      const personaId = chat.personaId ?? chat.pinnedPersonaId;
      let userName: string | null = null;
      if (personaId) {
        const p = (
          await db
            .select({ name: personas.name })
            .from(personas)
            .where(eq(personas.id, personaId))
            .limit(1)
        )[0];
        userName = p?.name ?? null;
      }

      const msgs = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(asc(messages.seq));

      const variantsByMsg = new Map<string, (typeof messageVariants.$inferSelect)[]>();
      if (msgs.length > 0) {
        const rows = await db
          .select()
          .from(messageVariants)
          .where(
            inArray(
              messageVariants.messageId,
              msgs.map((m) => m.id),
            ),
          );
        for (const r of rows) {
          const list = variantsByMsg.get(r.messageId) ?? [];
          list.push(r);
          variantsByMsg.set(r.messageId, list);
        }
      }

      const exportMsgs: ExportMessage[] = msgs.map((m) => ({
        role: m.role,
        content: m.content,
        sendDate: m.createdAt,
        model: m.model,
        provider: m.provider,
        tokensOut: m.tokensOut,
        genStarted: m.genStarted,
        genFinished: m.genFinished,
        activeVariantIdx: m.activeVariantIdx,
        variants: (variantsByMsg.get(m.id) ?? [])
          .sort((a, b) => a.idx - b.idx)
          .map((v) => ({
            content: v.content,
            model: v.model,
            provider: v.provider,
            tokensOut: v.tokensOut,
            genStarted: v.genStarted,
            genFinished: v.genFinished,
          })),
      }));

      const text = buildChatJsonl(
        {
          characterName: cv?.name ?? "Character",
          userName,
          createDate: chat.createdAt,
          parentRef: null,
          notePrompt: null,
        },
        exportMsgs,
      );
      return { text, filename: `${slug(cv?.name ?? "chat")}-${slug(chat.title ?? "chat")}.jsonl` };
    },
  };
}
