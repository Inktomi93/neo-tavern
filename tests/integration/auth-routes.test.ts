import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildApp } from "../../src/server/app";
import type { AuthConfig } from "../../src/server/auth/trust-header";
import { createSecretBox } from "../../src/server/crypto/secrets";
import { createAdminService } from "../../src/server/domain/admin";
import { createCharacterService } from "../../src/server/domain/character";
import { createChatService } from "../../src/server/domain/chat";
import { createCorpusService } from "../../src/server/domain/corpus";
import { createCredentialsService } from "../../src/server/domain/credentials";
import { createModelsService } from "../../src/server/domain/models";
import { createPersonaService } from "../../src/server/domain/persona";
import { createPresetService } from "../../src/server/domain/preset";
import { createSearchService } from "../../src/server/domain/search";
import { createSessionsService } from "../../src/server/domain/sessions";
import { createSettingsService } from "../../src/server/domain/settings";
import { createTagService } from "../../src/server/domain/tag";
import { createWorldInfoService } from "../../src/server/domain/world-info";
import { createCas } from "../../src/server/storage/cas";
import { freshDb, seedChatRow } from "../support/db";

// ── The end-to-end bypass regression (the test that would have caught this class of bug) ──────────
// The original hole survived because the ladder tests INJECT a pre-built AuthContext and never run
// the real seam under oidc — so they never proved `app.ts` wired each route to the auth check. These
// drive the REAL buildApp under an injected `oidc`+`owner` config (env is parsed once at import, so it
// can't be varied per-test → buildApp takes the config). The literal repro from the report:
//   • un-cookied request to the PUBLIC origin → 401 / UNAUTHORIZED (NOT owner+admin, NOT owner data)
//   • a valid session cookie → 200 (the owner)
//   • the raw-LAN-IP origin → owner (the documented convenience path, still working)

const OIDC: AuthConfig = {
  mode: "oidc",
  fallback: "owner",
  defaultHandle: "owner",
  verifyForwardJwt: true,
  trustedLocalHosts: [],
};

// The public FQDN (the domain/SSO path) vs the raw LAN IP (the owner-fallback path).
const PUBLIC = "neo-tavern.inktomi.tech";
const LAN = "192.168.1.50:8788";

let casRoot: string;
beforeEach(async () => {
  casRoot = await mkdtemp(join(tmpdir(), "neo-auth-routes-"));
});
afterEach(async () => {
  await rm(casRoot, { recursive: true, force: true });
});

async function setup() {
  const db = await freshDb();
  const cas = createCas(casRoot);
  const sessions = createSessionsService(db);
  const secretBox = createSecretBox(null);
  const services = {
    admin: createAdminService(db, sessions),
    sessions,
    credentials: createCredentialsService(db, secretBox),
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
  // The 5th arg threads the test's oidc config into the real auth seam.
  return { app: buildApp(db, cas, services, false, OIDC), db, services };
}

describe("auth at the route boundary (oidc + owner, real buildApp)", () => {
  test("export/chat: no cookie + PUBLIC origin → 401 (the owner's data is NOT served)", async () => {
    const { app, db } = await setup();
    const { chatId } = await seedChatRow(db, { greeting: "hi" }); // a real, owned chat exists…
    const res = await app.request(`/api/export/chat/${chatId}`, { headers: { host: PUBLIC } });
    expect(res.status).toBe(401); // …yet an anonymous public request cannot read it.
  });

  test("export/character: no cookie + PUBLIC origin → 401", async () => {
    const { app } = await setup();
    const res = await app.request("/api/export/character/anything", { headers: { host: PUBLIC } });
    expect(res.status).toBe(401);
  });

  test("tRPC authed query: no cookie + PUBLIC origin → 401 (not promoted to owner)", async () => {
    const { app } = await setup();
    const res = await app.request("/api/trpc/settings.getUserSettings", {
      headers: { host: PUBLIC },
    });
    expect(res.status).toBe(401);
  });

  test("tRPC admin query: no cookie + PUBLIC origin → 401 (not promoted to admin)", async () => {
    const { app } = await setup();
    const res = await app.request("/api/trpc/userAdmin.listUsers", { headers: { host: PUBLIC } });
    expect(res.status).toBe(401);
  });

  test("import/cards: no cookie + PUBLIC origin → 401 (no anonymous writes)", async () => {
    const { app } = await setup();
    const fd = new FormData();
    fd.append("files", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "x.png"));
    const res = await app.request("/api/import/cards", {
      method: "POST",
      body: fd,
      headers: { host: PUBLIC },
    });
    expect(res.status).toBe(401);
  });

  test("assets/upload: no cookie + PUBLIC origin → 401", async () => {
    const { app } = await setup();
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    fd.append("kind", "avatar");
    const res = await app.request("/api/assets/upload", {
      method: "POST",
      body: fd,
      headers: { host: PUBLIC },
    });
    expect(res.status).toBe(401);
  });

  test("export/chat: a VALID session cookie on the public origin → 200 (the owner)", async () => {
    const { app, db, services } = await setup();
    const { chatId, ownerId } = await seedChatRow(db, { greeting: "hi" });
    const { token } = await services.sessions.create({ userId: ownerId });
    const res = await app.request(`/api/export/chat/${chatId}`, {
      headers: { host: PUBLIC, cookie: `neo_session=${token}` },
    });
    expect(res.status).toBe(200);
  });

  test("LAN path preserved: export/chat with no cookie + private-IP origin → 200 (owner)", async () => {
    const { app, db } = await setup();
    const { chatId } = await seedChatRow(db, { greeting: "hi" });
    const res = await app.request(`/api/export/chat/${chatId}`, { headers: { host: LAN } });
    expect(res.status).toBe(200);
  });

  test("LAN path preserved: an admin tRPC query with no cookie + private-IP origin → 200", async () => {
    const { app } = await setup();
    const res = await app.request("/api/trpc/userAdmin.listUsers", { headers: { host: LAN } });
    expect(res.status).toBe(200);
  });
});
