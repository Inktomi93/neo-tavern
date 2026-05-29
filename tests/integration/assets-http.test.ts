import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildApp } from "../../src/server/app";
import { createAdminService } from "../../src/server/domain/admin";
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

let casRoot: string;
beforeEach(async () => {
  casRoot = await mkdtemp(join(tmpdir(), "neo-assets-http-"));
});
afterEach(async () => {
  await rm(casRoot, { recursive: true, force: true });
});

async function setupApp() {
  const db = await freshDb();
  const cas = createCas(casRoot);
  const services = {
    admin: createAdminService(db),
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

describe("Asset HTTP endpoints", () => {
  test("upload accepts multipart form data and creates a blob", async () => {
    const app = await setupApp();

    const formData = new FormData();
    const fileContent = new TextEncoder().encode("Hello, this is a test avatar!");
    formData.append("file", new File([fileContent], "avatar.png", { type: "image/png" }));
    formData.append("kind", "avatar");

    const res = await app.request("/api/assets/upload", {
      method: "POST",
      body: formData,
      headers: {
        "x-trust-user": "owner",
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hash).toBeDefined();
    expect(data.assetId).toBeDefined();
  });

  test("upload rejects missing file or invalid kind", async () => {
    const app = await setupApp();

    const formData1 = new FormData();
    formData1.append("kind", "avatar");

    const res1 = await app.request("/api/assets/upload", {
      method: "POST",
      body: formData1,
      headers: { "x-trust-user": "owner" },
    });
    expect(res1.status).toBe(400);

    const formData2 = new FormData();
    formData2.append("file", new File([new Uint8Array()], "a.png"));
    formData2.append("kind", "bogus"); // invalid kind

    const res2 = await app.request("/api/assets/upload", {
      method: "POST",
      body: formData2,
      headers: { "x-trust-user": "owner" },
    });
    expect(res2.status).toBe(400);
  });

  test("blob/:hash returns streaming blob with correct mime and caching", async () => {
    const app = await setupApp();

    // First, upload a blob
    const formData = new FormData();
    const fileContent = new TextEncoder().encode("Hello world image");
    formData.append("file", new File([fileContent], "test.png", { type: "image/png" }));
    formData.append("kind", "card");

    const uploadRes = await app.request("/api/assets/upload", {
      method: "POST",
      body: formData,
      headers: { "x-trust-user": "owner" },
    });
    const { hash } = await uploadRes.json();

    // Now fetch the blob
    const blobRes = await app.request(`/api/blob/${hash}`, {
      method: "GET",
    });

    expect(blobRes.status).toBe(200);
    expect(blobRes.headers.get("Content-Type")).toBe("image/png");
    expect(blobRes.headers.get("Content-Length")).toBe(fileContent.length.toString());
    expect(blobRes.headers.get("Cache-Control")).toContain("immutable");

    const fetchedContent = await blobRes.text();
    expect(fetchedContent).toBe("Hello world image");
  });

  test("blob/:hash returns 404 for invalid hash or missing blob", async () => {
    const app = await setupApp();

    const res1 = await app.request(`/api/blob/bogus_hash`, {
      method: "GET",
    });
    expect(res1.status).toBe(404);

    // syntactically valid hash but not in CAS
    const validHashButMissing = "a".repeat(64);
    const res2 = await app.request(`/api/blob/${validHashButMissing}`, {
      method: "GET",
    });
    expect(res2.status).toBe(404);
  });
});
