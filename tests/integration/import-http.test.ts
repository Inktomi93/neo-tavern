import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildApp } from "../../src/server/app";
import { createCharacterService } from "../../src/server/domain/character";
import { createChatService } from "../../src/server/domain/chat";
import { createCorpusService } from "../../src/server/domain/corpus";
import { createModelsService } from "../../src/server/domain/models";
import { createPersonaService } from "../../src/server/domain/persona";
import { createPresetService } from "../../src/server/domain/preset";
import { createSearchService } from "../../src/server/domain/search";
import { createSettingsService } from "../../src/server/domain/settings";
import { createTagService } from "../../src/server/domain/tag";
import { createWorldInfoService } from "../../src/server/domain/world-info";
import { createCas } from "../../src/server/storage/cas";
import { freshDb } from "../support/db";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/sillytavern");
const CARD = join(FIXTURE_DIR, "characters/Test Character.png");
const CHATS_DIR = join(FIXTURE_DIR, "chats/Test Character");

let casRoot: string;
beforeEach(async () => {
  casRoot = await mkdtemp(join(tmpdir(), "neo-import-http-"));
});
afterEach(async () => {
  await rm(casRoot, { recursive: true, force: true });
});

async function setupApp() {
  const db = await freshDb();
  const cas = createCas(casRoot);
  const services = {
    character: createCharacterService(db),
    chat: createChatService(db),
    corpus: createCorpusService(db),
    models: createModelsService(),
    persona: createPersonaService(db),
    preset: createPresetService(db),
    search: createSearchService(db),
    settings: createSettingsService(db),
    worldInfo: createWorldInfoService(db),
    tag: createTagService(db),
  };
  return buildApp(db, cas, services, false);
}

const post = (app: Awaited<ReturnType<typeof setupApp>>, path: string, body: FormData) =>
  app.request(path, { method: "POST", body, headers: { "x-trust-user": "owner" } });

describe("import HTTP routes", () => {
  test("POST /api/import/cards imports a PNG card", async () => {
    const app = await setupApp();
    const fd = new FormData();
    fd.append("files", new File([readFileSync(CARD)], "Test Character.png", { type: "image/png" }));

    const res = await post(app, "/api/import/cards", fd);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toHaveLength(1);
    expect(data.imported[0].ok).toBe(true);
    expect(data.imported[0].result.characterCreated).toBe(true);
  });

  test("POST /api/import/zip imports a full ST profile (card + all chats, branch linked)", async () => {
    const app = await setupApp();
    const files: Record<string, Uint8Array> = {
      "characters/Test Character.png": new Uint8Array(readFileSync(CARD)),
    };
    for (const f of readdirSync(CHATS_DIR)) {
      files[`chats/Test Character/${f}`] = new Uint8Array(readFileSync(join(CHATS_DIR, f)));
    }
    const zip = zipSync(files);

    const fd = new FormData();
    fd.append("file", new File([zip], "profile.zip", { type: "application/zip" }));
    const res = await post(app, "/api/import/zip", fd);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.characters).toHaveLength(1);
    expect(data.characters[0].chatsImported).toBe(7);
    expect(data.characters[0].branchesLinked).toBeGreaterThanOrEqual(1);
    expect(data.orphanChatDirs).toEqual([]);
  });

  test("POST /api/import/chats attaches a loose JSONL to an existing character; 404 if unknown", async () => {
    const app = await setupApp();
    // First create the character via the cards route, then read its id back.
    const cardFd = new FormData();
    cardFd.append(
      "files",
      new File([readFileSync(CARD)], "Test Character.png", { type: "image/png" }),
    );
    const characterId = (await (await post(app, "/api/import/cards", cardFd)).json()).imported[0]
      .result.characterId;

    const oneChat = readdirSync(CHATS_DIR).find((f) => f.endsWith(".jsonl")) ?? "";
    const fd = new FormData();
    fd.append("characterId", characterId);
    fd.append("files", new File([readFileSync(join(CHATS_DIR, oneChat))], oneChat));
    const res = await post(app, "/api/import/chats", fd);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.chatsImported).toBe(1);

    // Unknown character → 404.
    const bad = new FormData();
    bad.append("characterId", "does-not-exist");
    bad.append("files", new File([readFileSync(join(CHATS_DIR, oneChat))], oneChat));
    expect((await post(app, "/api/import/chats", bad)).status).toBe(404);
  });

  test("POST /api/import/cards rejects an empty request", async () => {
    const app = await setupApp();
    expect((await post(app, "/api/import/cards", new FormData())).status).toBe(400);
  });

  test("zip import is zip-slip safe: a `../` entry never escapes the temp dir", async () => {
    const app = await setupApp();
    // A unique escape target in the OS tmp root (the parent of the route's mkdtemp dir). Without the
    // guard, an entry of `../<name>` would land here; with it, the entry is skipped.
    const escapeName = `neo-zipslip-${Date.now()}-${process.pid}.txt`;
    const zip = zipSync({
      "characters/Test Character.png": new Uint8Array(readFileSync(CARD)),
      [`../${escapeName}`]: new TextEncoder().encode("escaped!"),
    });
    const fd = new FormData();
    fd.append("file", new File([zip], "evil.zip", { type: "application/zip" }));

    const res = await post(app, "/api/import/zip", fd);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.characters).toHaveLength(1); // the legit entry still imported
    expect(existsSync(join(tmpdir(), escapeName))).toBe(false); // the `../` entry was NOT written out
  });
});
