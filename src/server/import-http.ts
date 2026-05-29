import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import type { Hono } from "hono";
import type { Db } from "../db/client";
import { type AuthResolver, resolveOwner } from "./auth-context";
import { getAppConfig } from "./config/app-config";
import { DomainNotFoundError } from "./domain/_shared/errors";
import type { AssetsService } from "./domain/assets";
import {
  collectBundlesFromDir,
  createImportService,
  type ImportCharacterResult,
  type ImportChatInput,
  type ParsedCard,
  parseCardJson,
  parseCardPng,
  parseChatJsonl,
  slugifyHandle,
} from "./domain/import";
import { getLog } from "./observability/logger";

// First-class ST import over HTTP (the inverse of the export routes). Owner-scoped via the SAME auth
// seam as tRPC/export (resolveOwner) — every route requires a resolved identity (no anonymous
// owner-scope) + the CSRF header on these mutating POSTs. Lives in the entry layer — the one place
// allowed to wire domain/import + domain/assets together (the card PNG is stored as the avatar),
// exactly as the CLI (scripts/import-st.ts) does. Three inputs: individual cards (PNG/JSON), loose
// chat JSONL into an existing character (chosen explicitly — ST headers don't carry a reliable name),
// and a zip of a full ST profile (the bulk path; reuses the CLI pipeline).

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

// PNG magic: 89 50 4E 47. A card upload is either a PNG (with the embedded chunk) or a bare card JSON.
const isPng = (b: Uint8Array): boolean =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

// Locate the ST profile dir (the one with characters/ and/or chats/) inside an unzipped tree — the
// zip may wrap everything in a top-level folder (e.g. default-user/). Checks the root, then one level.
async function findProfileDir(root: string): Promise<string> {
  const hasProfile = async (dir: string): Promise<boolean> => {
    const names = new Set((await readdir(dir, { withFileTypes: true })).map((d) => d.name));
    return names.has("characters") || names.has("chats");
  };
  if (await hasProfile(root)) return root;
  for (const ent of await readdir(root, { withFileTypes: true })) {
    if (ent.isDirectory() && (await hasProfile(join(root, ent.name)))) return join(root, ent.name);
  }
  return root; // nothing matched → collectBundlesFromDir will just find nothing
}

export function registerImportRoutes(
  app: Hono,
  db: Db,
  assets: AssetsService,
  authResolver: AuthResolver,
): void {
  // POST /api/import/cards — one or more character cards (PNG with embedded chunk, or bare V2/V3 JSON).
  // multipart field `files` (repeatable) or `file`.
  app.post("/api/import/cards", async (c) => {
    const auth = await resolveOwner(authResolver, db, c.req.raw.headers, { requireCsrf: true });
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const owner = auth.handle;
    const body = await c.req.parseBody({ all: true });
    // biome-ignore lint/complexity/useLiteralKeys: parseBody returns an index signature (TS needs bracket access)
    const raw = body["files"] ?? body["file"];
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
    if (files.length === 0) return c.json({ error: "No card files provided" }, 400);

    const svc = createImportService(db, { ownerHandle: owner });
    const imported: {
      file: string;
      ok: boolean;
      result?: ImportCharacterResult;
      error?: string;
    }[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stem = file.name.replace(/\.(png|json)$/i, "");
      const parsed: ParsedCard | null = isPng(bytes)
        ? parseCardPng(bytes, stem)
        : parseCardJson(bytes, stem);
      if (!parsed) {
        imported.push({ file: file.name, ok: false, error: "unparseable card" });
        continue;
      }
      // The PNG card is its own avatar (one blob, both roles); a JSON card has no embedded image.
      let avatarAssetId: string | undefined;
      if (isPng(bytes)) {
        avatarAssetId = (await assets.store(bytes, "card", "image/png")).assetId;
      }
      const result = await svc.importCharacter({
        card: {
          handle: slugifyHandle(stem),
          parsed,
          importedFrom: file.name,
          importHash: sha256(bytes),
          ...(avatarAssetId !== undefined ? { avatarAssetId } : {}),
        },
        chats: [],
      });
      imported.push({ file: file.name, ok: true, result });
    }
    getLog().info({ owner, count: files.length }, "import: cards");
    return c.json({ imported });
  });

  // POST /api/import/chats — loose JSONL chats attached to an EXISTING character (multipart `files`
  // [repeatable] + a `characterId` form field; the UI picks the target since ST chat headers don't
  // carry a reliable character name).
  app.post("/api/import/chats", async (c) => {
    const auth = await resolveOwner(authResolver, db, c.req.raw.headers, { requireCsrf: true });
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const owner = auth.handle;
    const body = await c.req.parseBody({ all: true });
    // biome-ignore lint/complexity/useLiteralKeys: parseBody returns an index signature (TS needs bracket access)
    const characterId = typeof body["characterId"] === "string" ? body["characterId"] : "";
    if (!characterId) return c.json({ error: "characterId is required" }, 400);
    // biome-ignore lint/complexity/useLiteralKeys: parseBody returns an index signature (TS needs bracket access)
    const raw = body["files"] ?? body["file"];
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
    if (files.length === 0) return c.json({ error: "No chat files provided" }, 400);

    const chatsInput: ImportChatInput[] = [];
    const unparseable: string[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseChatJsonl(Buffer.from(bytes).toString("utf-8"), {
        fileName: file.name,
        charDirName: "import",
      });
      if (!parsed) {
        unparseable.push(file.name);
        continue;
      }
      chatsInput.push({ parsed, importedFrom: file.name, importHash: sha256(bytes) });
    }

    const svc = createImportService(db, { ownerHandle: owner });
    try {
      const result = await svc.importChats({ characterId, chats: chatsInput });
      getLog().info({ owner, characterId, files: files.length }, "import: chats");
      return c.json({ result, unparseable });
    } catch (err) {
      if (err instanceof DomainNotFoundError) {
        return c.json({ error: "character not found", characterId }, 404);
      }
      throw err;
    }
  });

  // POST /api/import/zip — a zip of an ST profile dir (characters/*.png + chats/<charDir>/*.jsonl).
  // The bulk migration path: reuses the exact CLI pipeline (collectBundlesFromDir → importCharacter),
  // so card↔chat pairing, branch-linking, idempotency, and the skip-list all come for free.
  app.post("/api/import/zip", async (c) => {
    const auth = await resolveOwner(authResolver, db, c.req.raw.headers, { requireCsrf: true });
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const owner = auth.handle;
    const body = await c.req.parseBody();
    // biome-ignore lint/complexity/useLiteralKeys: parseBody returns an index signature (TS needs bracket access)
    const file = body["file"];
    if (!(file instanceof File)) return c.json({ error: "Missing zip file" }, 400);

    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    } catch {
      return c.json({ error: "Invalid zip archive" }, 400);
    }

    const tmp = await mkdtemp(join(tmpdir(), "neo-import-"));
    const root = resolve(tmp) + sep;
    try {
      for (const [path, data] of Object.entries(entries)) {
        if (path.endsWith("/") || data.length === 0) continue; // directory entry
        const dest = join(tmp, path);
        // Zip-slip guard: fflate returns entry paths verbatim (it does NOT strip `../`), so a hostile
        // archive could escape `tmp` into an arbitrary file write. Skip anything resolving outside root.
        if (!resolve(dest).startsWith(root)) continue;
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, data);
      }
      const profileDir = await findProfileDir(tmp);
      const collected = await collectBundlesFromDir(
        profileDir,
        getAppConfig().importSkipCharacters,
      );
      const svc = createImportService(db, { ownerHandle: owner });
      const characters: ImportCharacterResult[] = [];
      for (const bundle of collected.bundles) {
        if (bundle.card.cardBytes) {
          bundle.card.avatarAssetId = (
            await assets.store(bundle.card.cardBytes, "card", "image/png")
          ).assetId;
        }
        characters.push(await svc.importCharacter(bundle));
      }
      getLog().info(
        { owner, characters: characters.length, orphans: collected.orphanChatDirs.length },
        "import: zip",
      );
      return c.json({
        characters,
        orphanChatDirs: collected.orphanChatDirs,
        unreadableCards: collected.unreadableCards,
        skippedCharacters: collected.skippedCharacters,
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
}
