// Import orchestration — maps parsed ST structures (ParsedCard + ParsedChat[]) onto our
// schema: characters → character_versions → world_books/world_entries(+cv junction), and
// chats → messages → message_variants, then resolves branch parents (character-wide).
//
// PURE of file I/O: takes already-parsed structures + their source identity (importHash,
// importedFrom) and writes rows. The jobs-layer runner (pnpm import:st) does the file
// walking + hashing + parsing and drives this through the front door.
//
// Idempotency (locked, see docs/data-model.md + corpus-import.md):
//   • character: matched by (ownerId, handle). Same importHash ⇒ no-op. Different ⇒ a new
//     character_versions row (copy-on-write: existing chats stay pinned to their old
//     version), currentVersionId advances.
//   • chat: matched by importHash (file bytes). Match ⇒ skip the whole message re-write.
// Re-running an import is therefore safe and resumable after a partial failure.

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../../db/client";
import {
  characters,
  characterVersions,
  characterVersionWorldEntries,
  chats,
  messages,
  messageVariants,
  worldBooks,
  worldEntries,
} from "../../../db/schema";
import { getLog } from "../../observability/logger";
import { DomainNotFoundError } from "../_shared/errors";
import { newId } from "../_shared/ids";
import { ensureUser } from "../_shared/users";
import type { ParsedCard } from "./card";
import type { ParsedChat } from "./chat";

// Imported chats carry this as chats.provider — honest provenance; the real per-message
// model/api live on messages/message_variants. (chats.provider is notNull free text.)

/** Stable character handle from a name/filename. Lowercase + non-alphanumeric → hyphens;
 *  this is what collapses ST's case-variant chat dirs ("Block of Cheese" / "Block Of
 *  Cheese") onto one character. Exported so the runner pairs cards↔chat-dirs the same way. */
export function slugifyHandle(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unnamed";
}

export interface ImportCardInput {
  handle: string; // slugifyHandle(pngStem) — the character identity key
  parsed: ParsedCard;
  importedFrom: string; // PNG filename
  importHash: string; // SHA-256 of the card bytes
  // Raw PNG bytes (loader output). The composition root stores these as the card's avatar asset
  // and sets `avatarAssetId`; the import service itself ignores `cardBytes`. (domain/import can't
  // import domain/assets — cross-feature — so the store happens in the CLI that wires both.)
  cardBytes?: Uint8Array;
  // The stored avatar asset id (set by the composition root after storing cardBytes) → written onto
  // character_versions.avatarAssetId. The card PNG is the avatar (one blob, both roles).
  avatarAssetId?: string;
}
export interface ImportChatInput {
  parsed: ParsedChat;
  importedFrom: string; // .jsonl filename (branch-resolution + provenance key)
  importHash: string; // SHA-256 of the file bytes
}
export interface ImportCharacterInput {
  card: ImportCardInput;
  chats: ImportChatInput[];
}
export interface ImportCharacterResult {
  characterId: string;
  versionId: string;
  characterCreated: boolean;
  versionBumped: boolean;
  chatsImported: number;
  chatsSkipped: number;
  messagesImported: number;
  variantsImported: number;
  worldEntriesImported: number;
  branchesLinked: number;
}
// Standalone chat import: attach loose JSONL chats to an EXISTING character (chosen explicitly — ST
// chat headers don't reliably carry the character name, so there's no safe auto-match for a loose file).
export interface ImportChatsInput {
  characterId: string;
  chats: ImportChatInput[];
}
export interface ImportChatsResult {
  characterId: string;
  versionId: string;
  chatsImported: number;
  chatsSkipped: number;
  messagesImported: number;
  variantsImported: number;
  branchesLinked: number;
}
export interface ImportService {
  importCharacter(input: ImportCharacterInput): Promise<ImportCharacterResult>;
  /** Import loose chats into an existing character's current version (the standalone-JSONL path). */
  importChats(input: ImportChatsInput): Promise<ImportChatsResult>;
}
export interface ImportServiceDeps {
  ownerHandle: string; // the import owner (DEFAULT_USER_HANDLE) — ensured lazily, once
}

function loreEntryColumns(entry: Record<string, unknown>): {
  title: string;
  content: string;
  legacyKeys: unknown;
  enabled: boolean;
  priority: number;
} {
  const keys = Array.isArray(entry["keys"]) ? entry["keys"] : [];
  const firstKey = typeof keys[0] === "string" ? keys[0] : "";
  const title =
    (typeof entry["comment"] === "string" && entry["comment"]) ||
    (typeof entry["name"] === "string" && entry["name"]) ||
    firstKey ||
    "Untitled";
  const order = Number(entry["insertion_order"]);
  return {
    title,
    content: typeof entry["content"] === "string" ? entry["content"] : "",
    legacyKeys: keys, // ST keyword triggers — import compat only, never scanned
    enabled: entry["enabled"] !== false,
    priority: Number.isFinite(order) ? order : 0,
  };
}

export function createImportService(db: Db, deps: ImportServiceDeps): ImportService {
  const log = getLog();
  let ownerIdCache: string | null = null;
  async function owner(): Promise<string> {
    if (ownerIdCache === null) ownerIdCache = await ensureUser(db, deps.ownerHandle);
    return ownerIdCache;
  }

  return {
    async importCharacter(input) {
      const ownerId = await owner();
      const now = Date.now();
      const { handle, parsed: card, importHash, importedFrom } = input.card;

      // ── Character + version (copy-on-write) ───────────────────────────────
      const existing = (
        await db
          .select()
          .from(characters)
          .where(and(eq(characters.ownerId, ownerId), eq(characters.handle, handle)))
          .limit(1)
      )[0];

      let characterId: string;
      let versionId: string;
      let characterCreated = false;
      let versionBumped = false;
      let worldEntriesImported = 0;

      // Insert a character_versions row (+ its lorebook → world_book/entries/junction).
      const insertVersion = async (charId: string, version: number): Promise<string> => {
        const vId = newId();
        await db.insert(characterVersions).values({
          id: vId,
          characterId: charId,
          version,
          name: card.name,
          description: card.description ?? "",
          personality: card.personality,
          scenario: card.scenario,
          // Fold first_mes + alternate_greetings into ONE ordered array ([0] = first message),
          // dropping empties. Retains every greeting; the full original card stays in `raw`.
          greetings: [card.firstMessage, ...card.alternateGreetings].filter(
            (g): g is string => typeof g === "string" && g.trim().length > 0,
          ),
          exampleMessages: card.exampleMessages,
          systemPrompt: card.systemPrompt,
          postHistoryInstructions: card.postHistoryInstructions,
          tags: card.tags,
          creatorNotes: card.creatorNotes,
          avatarAssetId: input.card.avatarAssetId ?? null, // set by the CLI after storing the card PNG
          raw: card.raw,
          createdAt: now,
        });
        if (card.lorebookEntries.length > 0) {
          const wbId = newId();
          await db
            .insert(worldBooks)
            .values({ id: wbId, ownerId, name: `${card.name} lorebook`, createdAt: now });
          for (const entry of card.lorebookEntries) {
            const weId = newId();
            const cols = loreEntryColumns(entry);
            await db
              .insert(worldEntries)
              .values({ id: weId, worldBookId: wbId, ...cols, metadata: entry });
            await db
              .insert(characterVersionWorldEntries)
              .values({ characterVersionId: vId, entryId: weId, scope: "always" });
            worldEntriesImported++;
          }
        }
        return vId;
      };

      if (!existing) {
        characterId = newId();
        await db
          .insert(characters)
          .values({ id: characterId, ownerId, handle, importedFrom, importHash, createdAt: now });
        versionId = await insertVersion(characterId, 1);
        await db
          .update(characters)
          .set({ currentVersionId: versionId })
          .where(eq(characters.id, characterId));
        characterCreated = true;
      } else {
        characterId = existing.id;
        if (existing.importHash === importHash && existing.currentVersionId) {
          versionId = existing.currentVersionId; // unchanged card → reuse the pinned version
        } else {
          const maxV =
            (
              await db
                .select({ v: characterVersions.version })
                .from(characterVersions)
                .where(eq(characterVersions.characterId, characterId))
                .orderBy(desc(characterVersions.version))
                .limit(1)
            )[0]?.v ?? 0;
          versionId = await insertVersion(characterId, maxV + 1);
          await db
            .update(characters)
            .set({ currentVersionId: versionId, importHash, importedFrom })
            .where(eq(characters.id, characterId));
          versionBumped = true;
        }
      }

      // ── Chats → messages → variants + branch resolution ───────────────────
      const counts = await importChatsIntoVersion(
        ownerId,
        characterId,
        versionId,
        input.chats,
        now,
      );

      // INFO so a `pnpm import:st` run shows per-character progress + counts at the default level
      // (an import is a rare, watched batch job — metadata only, never card/chat content).
      log.info(
        { handle, characterCreated, versionBumped, worldEntriesImported, ...counts },
        "imported character",
      );
      return {
        characterId,
        versionId,
        characterCreated,
        versionBumped,
        worldEntriesImported,
        ...counts,
      };
    },

    async importChats(input) {
      const ownerId = await owner();
      const now = Date.now();
      const character = (
        await db
          .select({ id: characters.id, currentVersionId: characters.currentVersionId })
          .from(characters)
          .where(and(eq(characters.ownerId, ownerId), eq(characters.id, input.characterId)))
          .limit(1)
      )[0];
      if (!character?.currentVersionId) {
        throw new DomainNotFoundError("character", input.characterId);
      }
      const counts = await importChatsIntoVersion(
        ownerId,
        character.id,
        character.currentVersionId,
        input.chats,
        now,
      );
      log.info({ characterId: character.id, ...counts }, "imported chats (standalone)");
      return { characterId: character.id, versionId: character.currentVersionId, ...counts };
    },
  };

  // Import a chat list into an existing character version: dup-skip by importHash, write
  // chats/messages/variants, then resolve branch parents (parentRef filename → parent chat id)
  // character-wide. Shared by importCharacter and the standalone importChats (loose JSONL into an
  // existing character).
  async function importChatsIntoVersion(
    ownerId: string,
    characterId: string,
    versionId: string,
    chatsInput: ImportChatInput[],
    now: number,
  ): Promise<{
    chatsImported: number;
    chatsSkipped: number;
    messagesImported: number;
    variantsImported: number;
    branchesLinked: number;
  }> {
    let chatsImported = 0;
    let chatsSkipped = 0;
    let messagesImported = 0;
    let variantsImported = 0;
    const pendingParents: { chatId: string; parentRef: string; forkedAt: number }[] = [];

    for (const ci of chatsInput) {
      const dup = (
        await db
          .select({ id: chats.id })
          .from(chats)
          .where(and(eq(chats.ownerId, ownerId), eq(chats.importHash, ci.importHash)))
          .limit(1)
      )[0];
      if (dup) {
        chatsSkipped++;
        continue; // true idempotent skip — messages already written
      }

      const pc = ci.parsed;
      const created =
        pc.createDate ?? pc.messages.find((m) => m.sendDate !== null)?.sendDate ?? now;
      const chatId = newId();
      await db.insert(chats).values({
        id: chatId,
        ownerId,
        title: ci.importedFrom.replace(/\.jsonl$/, ""),
        characterVersionId: versionId,
        // Imported ST chats are continuable Claude chats: agent-sdk on the Max sub (seedable from
        // canon on demand). sessionId stays null until the first send seeds/resumes a session.
        api: "agent-sdk",
        source: "max-pro-sub",
        sessionId: null,
        importedFrom: ci.importedFrom,
        importHash: ci.importHash,
        messageCount: pc.messages.length,
        metadata: { bucket: pc.bucket, isBranch: pc.isBranch, notePrompt: pc.notePrompt },
        createdAt: created,
        updatedAt: now,
      });
      if (pc.parentRef) pendingParents.push({ chatId, parentRef: pc.parentRef, forkedAt: created });

      let seq = 0;
      for (const m of pc.messages) {
        const msgId = newId();
        await db.insert(messages).values({
          id: msgId,
          chatId,
          seq,
          role: m.role,
          content: m.content,
          model: m.model,
          provider: m.provider,
          tokensOut: m.tokensOut,
          genStarted: m.genStarted,
          genFinished: m.genFinished,
          activeVariantIdx: m.activeVariantIdx,
          createdAt: m.sendDate ?? created,
        });
        messagesImported++;
        for (const v of m.variants) {
          await db.insert(messageVariants).values({
            id: newId(),
            messageId: msgId,
            idx: v.idx,
            content: v.content,
            model: v.model,
            provider: v.provider,
            tokensOut: v.tokensOut,
            genStarted: v.genStarted,
            genFinished: v.genFinished,
            createdAt: now,
          });
          variantsImported++;
        }
        seq++;
      }
      chatsImported++;
    }

    // ── Branch resolution (pass 2, character-wide) ────────────────────────
    // Resolve parentRef (a parent FILENAME) → the parent chat's id, across ALL of this
    // character's chats (every version + prior runs), not just this dir/run.
    let branchesLinked = 0;
    if (pendingParents.length > 0) {
      const versionIds = (
        await db
          .select({ id: characterVersions.id })
          .from(characterVersions)
          .where(eq(characterVersions.characterId, characterId))
      ).map((r) => r.id);
      const allChats = await db
        .select({ id: chats.id, importedFrom: chats.importedFrom })
        .from(chats)
        .where(inArray(chats.characterVersionId, versionIds));
      const byFile = new Map<string, string>();
      for (const c of allChats) {
        if (c.importedFrom) byFile.set(c.importedFrom, c.id);
      }
      for (const p of pendingParents) {
        const parentId = byFile.get(p.parentRef);
        if (parentId && parentId !== p.chatId) {
          await db
            .update(chats)
            .set({ parentChatId: parentId, forkedAt: p.forkedAt })
            .where(eq(chats.id, p.chatId));
          branchesLinked++;
        }
      }
    }

    return { chatsImported, chatsSkipped, messagesImported, variantsImported, branchesLinked };
  }
}
