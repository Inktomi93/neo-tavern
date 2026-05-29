import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["card", "avatar", "export"] }).notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  // sha-256 hex of the bytes == the CAS key (== characters.importHash for a card PNG — same file hash).
  hash: text("hash").notNull().unique(),
  uploadedAt: integer("uploaded_at").notNull(), // asset creation time (epoch-ms UTC)
});

// Polymorphic. `embedding` is the libSQL native vector (BGE-M3, 1024-dim); the ANN
// index (libsql_vector_idx) is hand-added in migration 0001 since drizzle-kit can't
// emit it. Query via vector_top_k('embeddings_ann', vector32(?), k).
// Character-card vectors — the owner-keyed dedicated table that REPLACES the legacy polymorphic
// `embeddings` (migration 0020). Mirrors chat_segments/chat_digests: a denormalized `ownerId` column
// gives cross-character corpus search a direct WHERE filter, retiring the old over-fetch + join-back
// owner scoping. One row per (character, model) — idempotent upsert. CSLS `hubScore` per model
// (precomputed by `pnpm csls`; query-time re-rank adjusted_dist = max(0, dist - 1 + hub_score)).
// `sourceText` = the card identity text that was embedded (the two-stage reranker scores it). The
// libsql_vector_idx ANN index `character_embeddings_ann` is hand-added in the migration (drizzle-kit
// can't emit it). Footgun: never bulk `DELETE FROM` (poisons the shadow index) — targeted deletes only.
