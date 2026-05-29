import type { Db } from "../../../db/client";
import { auditLogs } from "../../../db/schema";
import { newId } from "./ids";

export async function logAudit(
  db: Db,
  action: string,
  domain: string,
  entityId: string,
  details: unknown,
  timestamp: number = Date.now(),
): Promise<void> {
  await db.insert(auditLogs).values({
    id: newId(),
    timestamp,
    action,
    domain,
    entityId,
    details,
  });
}
