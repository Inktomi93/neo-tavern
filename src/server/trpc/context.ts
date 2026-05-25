import { getLog } from "../observability/logger";
import { APP_VERSION } from "../version";

export interface Context {
  username: string | null;
  version: string;
  // Request-scoped logger (carries the request id). Procedures log via ctx.log.
  log: ReturnType<typeof getLog>;
}

export function createContext(): Context {
  // Auth is terminated at Caddy, which injects X-Authentik-Username. The app
  // trusts that header; reading it is wired in Phase 2.
  return { username: null, version: APP_VERSION, log: getLog() };
}
