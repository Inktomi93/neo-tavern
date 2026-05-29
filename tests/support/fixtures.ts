import { test as baseTest } from "vitest";
import type { Db } from "../../src/db/client";
import { createAdminService } from "../../src/server/domain/admin";
import { createCharacterService } from "../../src/server/domain/character";
import { createChatService } from "../../src/server/domain/chat";
import { createCorpusService } from "../../src/server/domain/corpus";
import { createModelsService } from "../../src/server/domain/models";
import { createPersonaService } from "../../src/server/domain/persona";
import { createPresetService } from "../../src/server/domain/preset";
import { createSearchService } from "../../src/server/domain/search";
import { createSessionsService } from "../../src/server/domain/sessions";
import { createSettingsService } from "../../src/server/domain/settings";
import { createTagService } from "../../src/server/domain/tag";
import { createWorldInfoService } from "../../src/server/domain/world-info";
import { type AuthContext, createContext } from "../../src/server/trpc/context";
import { appRouter } from "../../src/server/trpc/router";
import { freshDb } from "./db";

export interface AppServices {
  admin: ReturnType<typeof createAdminService>;
  character: ReturnType<typeof createCharacterService>;
  chat: ReturnType<typeof createChatService>;
  corpus: ReturnType<typeof createCorpusService>;
  models: ReturnType<typeof createModelsService>;
  persona: ReturnType<typeof createPersonaService>;
  preset: ReturnType<typeof createPresetService>;
  search: ReturnType<typeof createSearchService>;
  sessions: ReturnType<typeof createSessionsService>;
  settings: ReturnType<typeof createSettingsService>;
  tag: ReturnType<typeof createTagService>;
  worldInfo: ReturnType<typeof createWorldInfoService>;
}

export type IntegrationFixtures = {
  db: Db;
  services: AppServices;
  ownerCaller: ReturnType<typeof appRouter.createCaller>;
  otherCaller: ReturnType<typeof appRouter.createCaller>;
};

export const test = baseTest.extend<IntegrationFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Vitest fixture
  db: async ({}, use) => {
    const dbInstance = await freshDb();
    await use(dbInstance);
  },
  services: async ({ db }, use) => {
    const sessions = createSessionsService(db);
    const services: AppServices = {
      admin: createAdminService(db, sessions),
      character: createCharacterService(db),
      chat: createChatService(db),
      corpus: createCorpusService(db),
      models: createModelsService(),
      persona: createPersonaService(db),
      preset: createPresetService(db),
      search: createSearchService(db),
      sessions,
      settings: createSettingsService(db),
      tag: createTagService(db),
      worldInfo: createWorldInfoService(db),
    };
    await use(services);
  },
  ownerCaller: async ({ services }, use) => {
    await use(callerFor(services, authFor("owner", { role: "admin" })));
  },
  otherCaller: async ({ services }, use) => {
    await use(callerFor(services, authFor("other", { role: "user" })));
  },
});

// Build an explicit AuthContext for a tRPC caller — tests state the auth they act under (no hidden
// synthesis), so the procedure ladder (authed/admin/CSRF) is exercised honestly. Defaults model the
// header/fallback path (identity present, no cookie → CSRF gate inert); override per test for the
// un-authed (identity:null), admin, or cookie-mutation (viaCookie + hasCsrfHeader) cases.
export function authFor(handle: string, over: Partial<AuthContext> = {}): AuthContext {
  return {
    identity: { externalId: null, handle, groups: [] },
    viaCookie: false,
    hasCsrfHeader: true,
    role: "user",
    ...over,
  };
}

// A caller that acts with no resolved identity (AUTH_FALLBACK=deny, no credential) — authedProcedure
// must 401 it.
export const ANONYMOUS_AUTH: AuthContext = {
  identity: null,
  viaCookie: false,
  hasCsrfHeader: false,
  role: "user",
};

export function callerFor(services: AppServices, auth: AuthContext) {
  return appRouter.createCaller(createContext({ services, auth }));
}
