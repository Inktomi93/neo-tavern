import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ───────────────────────── Audit Logging ─────────────────────────
// Append-only audit trail for destructive actions and global configuration changes.
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    timestamp: integer("timestamp").notNull(),
    action: text("action").notNull(),
    domain: text("domain").notNull(),
    entityId: text("entity_id"),
    details: text("details", { mode: "json" }),
  },
  (t) => [index("audit_logs_time_idx").on(t.timestamp)],
);
