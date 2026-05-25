// Filesystem loader for the ST importer: walks a staged profile dir, reads + hashes +
// parses the PNG cards and chat JSONL, and pairs them into per-character bundles ready
// for the import service. Lives in domain (no db, testable against a fixture corpus);
// the scripts/import-st.ts CLI bootstraps the db and drives importCharacter over these.
//
// Layout expected (a single ST user profile):
//   <profileDir>/characters/*.png
//   <profileDir>/chats/<charDir>/*.jsonl
// Cards and chat dirs are paired by slugifyHandle — which is what collapses ST's
// case-variant chat dirs ("Block of Cheese" / "Block Of Cheese") onto one character.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCardPng } from "./card";
import { parseChatJsonl } from "./chat";
import {
  type ImportCardInput,
  type ImportCharacterInput,
  type ImportChatInput,
  slugifyHandle,
} from "./service";

export interface CollectResult {
  bundles: ImportCharacterInput[];
  orphanChatDirs: string[]; // chat dirs whose handle matched no card — skipped (no version to pin)
  unreadableCards: string[]; // PNGs with no parseable card data
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listDir(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // a profile may have only characters/ or only chats/
  }
}

export async function collectBundlesFromDir(profileDir: string): Promise<CollectResult> {
  type Group = { card?: ImportCardInput; chats: ImportChatInput[] };
  const byHandle = new Map<string, Group>();
  const group = (handle: string): Group => {
    let g = byHandle.get(handle);
    if (!g) {
      g = { chats: [] };
      byHandle.set(handle, g);
    }
    return g;
  };
  const unreadableCards: string[] = [];

  // ── Cards ──────────────────────────────────────────────────────────────
  const charsDir = join(profileDir, "characters");
  for (const ent of await listDir(charsDir)) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith(".png")) continue;
    const bytes = await readFile(join(charsDir, ent.name));
    const stem = ent.name.replace(/\.png$/i, "");
    const parsed = parseCardPng(bytes, stem);
    if (!parsed) {
      unreadableCards.push(ent.name);
      continue;
    }
    group(slugifyHandle(stem)).card = {
      handle: slugifyHandle(stem),
      parsed,
      importedFrom: ent.name,
      importHash: sha256(bytes),
    };
  }

  // ── Chats (one level of <charDir>/ under chats/) ─────────────────────────
  const chatsDir = join(profileDir, "chats");
  for (const dirEnt of await listDir(chatsDir)) {
    if (!dirEnt.isDirectory()) continue;
    const handle = slugifyHandle(dirEnt.name);
    const dirPath = join(chatsDir, dirEnt.name);
    for (const fileEnt of await listDir(dirPath)) {
      if (!fileEnt.isFile() || !fileEnt.name.toLowerCase().endsWith(".jsonl")) continue;
      const bytes = await readFile(join(dirPath, fileEnt.name));
      const parsed = parseChatJsonl(bytes.toString("utf-8"), {
        fileName: fileEnt.name,
        charDirName: dirEnt.name,
      });
      if (!parsed) continue; // unparseable header — skip this file
      group(handle).chats.push({ parsed, importedFrom: fileEnt.name, importHash: sha256(bytes) });
    }
  }

  // ── Pair → bundles; chats without a card are orphans ─────────────────────
  const bundles: ImportCharacterInput[] = [];
  const orphanChatDirs: string[] = [];
  for (const [handle, g] of byHandle) {
    if (g.card) bundles.push({ card: g.card, chats: g.chats });
    else if (g.chats.length > 0) orphanChatDirs.push(handle);
  }
  return { bundles, orphanChatDirs, unreadableCards };
}
