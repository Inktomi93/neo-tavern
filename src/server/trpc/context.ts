import type { ChatService } from "../domain/chat";
import { getLog } from "../observability/logger";
import { APP_VERSION } from "../version";

// Domain services, built by the composition root (src/server/index.ts) with the db
// injected, and handed to each request. tRPC procedures call domain ONLY through
// here — they never touch db/providers/auth (the layer cake forbids it, even
// type-only). Add a service per domain feature as they land.
export interface Services {
  chat: ChatService;
}

export interface Context {
  // Resolved at the auth seam in the composition root (trusted header → that user;
  // else DEFAULT_USER_HANDLE). Always a handle; domain resolves it to a user row.
  username: string;
  version: string;
  // Request-scoped logger (carries the request id). Procedures log via ctx.log.
  log: ReturnType<typeof getLog>;
  services: Services;
}

// Pure packaging — the request's resolved username + the shared services. No db,
// no auth, no header parsing here (that's the composition root's job).
export function createContext(params: { username: string; services: Services }): Context {
  return {
    username: params.username,
    version: APP_VERSION,
    log: getLog(),
    services: params.services,
  };
}
