// A browser session row as exposed to admins (the userAdmin "list/revoke my devices" surface). A pure
// DTO in `shared` so the sessions feature (which produces it) and the admin feature (which lists it
// via an injected port) can both name it WITHOUT a cross-feature import (domain-no-cross-feature). The
// opaque token + its hash never appear here. See docs/auth/auth-and-credentials-plan.md §4.
import type { SessionId } from "./ids";

export interface SessionView {
  id: SessionId;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
  userAgent: string | null;
}
