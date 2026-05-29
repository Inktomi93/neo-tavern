import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { users } from "../../../db/schema";
import { DomainForbiddenError } from "./errors";
import { ensureUser } from "./users";

// The single admin-gate seam. Today the gate is real but narrow: only the owner
// (DEFAULT_USER_HANDLE, provisioned as role="admin" by ensureUser) passes; any other
// JIT-provisioned user is role="user" and rejected. When multi-user lands, granting admin
// becomes a role mutation — this check doesn't change. Returns the resolved ownerId so callers
// can chain (e.g. scope a write) without a second lookup.
export async function requireAdmin(db: Db, username: string): Promise<string> {
  const ownerId = await ensureUser(db, username);
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (rows[0]?.role !== "admin") {
    throw new DomainForbiddenError("This action requires an admin user.");
  }
  return ownerId;
}
