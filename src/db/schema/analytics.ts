import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./tenancy";

// Corpus-analytics ROLLUPS — precomputed by scripts (the all-pairs matmul is too heavy for a live
// request; the tRPC layer reads these tables, same pattern as CSLS `hub_score`). Derived + regenerable
// from the vector tables, so NO FKs on the polymorphic `entity_id_*` refs (a character id OR a chat id,
// resolved by `entity_type`) — they stay plain `text`, mirroring `embeddings`/`taggables`. The owner FK
// is real (rollups are per-user). Model-tagged so an embedder swap is detectable as stale.

// Near-duplicate pairs (characters or chats) ≥ a cosine threshold. Pairs are stored canonically
// (entityIdA < entityIdB lexicographically) so the unique index dedupes (a,b)/(b,a). `relation`
// distinguishes a genuine near-dup from a known fork lineage (B.5.1): chat pairs sharing a fork root
// are `forked` (surface as "3 forks of this chat"), independent look-alikes are `duplicate`.
export const duplicatePairs = sqliteTable(
  "duplicate_pairs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    entityType: text("entity_type").notNull(), // 'character' | 'chat'
    entityIdA: text("entity_id_a").notNull(), // canonical: A < B
    entityIdB: text("entity_id_b").notNull(),
    similarity: real("similarity").notNull(), // raw cosine (card-curator-comparable; threshold knob)
    cslsScore: real("csls_score"), // CSLS-adjusted (2·cos − hubA − hubB); the ranking key (hubs sink)
    relation: text("relation").notNull().default("duplicate"), // 'duplicate' | 'forked'
    model: text("model").notNull(), // embedder model that produced the vectors (stale-check)
    computedAt: integer("computed_at").notNull(),
  },
  (t) => [
    uniqueIndex("duplicate_pairs_unq").on(t.ownerId, t.entityType, t.entityIdA, t.entityIdB),
    // The list query: owner + type, ordered by similarity desc.
    index("duplicate_pairs_lookup_idx").on(t.ownerId, t.entityType, t.similarity),
  ],
);
