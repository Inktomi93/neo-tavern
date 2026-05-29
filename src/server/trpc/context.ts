import type { ResolvedIdentity } from "../../shared/identity";
import type { AdminService } from "../domain/admin";
import type { CharacterService } from "../domain/character";
import type { ChatService } from "../domain/chat";
import type { CorpusService } from "../domain/corpus";
import type { ModelsService } from "../domain/models";
import type { PersonaService } from "../domain/persona";
import type { PresetService } from "../domain/preset";
import type { SearchService } from "../domain/search";
import type { SessionsService } from "../domain/sessions";
import type { SettingsService } from "../domain/settings";
import type { TagService } from "../domain/tag";
import type { WorldInfoService } from "../domain/world-info";
import { env } from "../env";
import { getLog } from "../observability/logger";
import { APP_VERSION } from "../version";

// Domain services, built by the composition root (src/server/index.ts) with the db
// injected, and handed to each request. tRPC procedures call domain ONLY through
// here — they never touch db/providers/auth (the layer cake forbids it, even
// type-only). Add a service per domain feature as they land.
export interface Services {
  admin: AdminService;
  character: CharacterService;
  chat: ChatService;
  corpus: CorpusService;
  models: ModelsService;
  persona: PersonaService;
  preset: PresetService;
  search: SearchService;
  sessions: SessionsService;
  settings: SettingsService;
  tag: TagService;
  worldInfo: WorldInfoService;
}

// The resolved auth for a request — produced at the composition-root seam (which is allowed to touch
// db + the auth layer) and carried here as plain data, so the procedure ladder (trpc.ts) can gate
// without reaching into auth/db itself.
export interface AuthContext {
  // null only under AUTH_FALLBACK=deny with no credential → authedProcedure 401s.
  identity: ResolvedIdentity | null;
  // True iff the identity came from the session cookie — the CSRF mutation-gate discriminator (a
  // cookie request has a cross-site surface; a header/fallback request does not).
  viaCookie: boolean;
  // The custom CSRF header was present on this request (any value).
  hasCsrfHeader: boolean;
  // The caller's access role (admin gates the admin surfaces). Resolved at the seam.
  role: "admin" | "user";
}

export interface Context {
  // The resolved handle. Always present (DEFAULT_USER_HANDLE under the owner fallback); domain
  // resolves it to a user row. Kept for the ~30 ensureUser(handle) call sites.
  username: string;
  // The richer resolved auth (identity/role/CSRF signal) for the procedure ladder.
  auth: AuthContext;
  version: string;
  // Request-scoped logger (carries the request id). Procedures log via ctx.log.
  log: ReturnType<typeof getLog>;
  services: Services;
}

// Pure packaging — `auth` is the single source of truth (built at the composition-root seam, or
// explicitly in tests), and `username` is DERIVED from it (the resolved handle, or DEFAULT_USER_HANDLE
// when there's no identity — a value that never reaches a domain verb, since authedProcedure 401s
// first). No db, no header parsing here; that's the seam's job. No synthesized identity — a caller
// must state the auth it's acting under, so the procedure ladder is exercised honestly.
export function createContext(params: { services: Services; auth: AuthContext }): Context {
  return {
    username: params.auth.identity?.handle ?? env.DEFAULT_USER_HANDLE,
    auth: params.auth,
    version: APP_VERSION,
    log: getLog(),
    services: params.services,
  };
}
