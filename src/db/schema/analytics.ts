import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { characters } from "./characters";
import { vector32 } from "./custom-types";
import { chatDigests } from "./search";
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

// Keyword×keyword co-occurrence (Pillar A — docs/planning/breadth-buildout.md B.3). Two keywords
// co-occur when both appear in one tier-0 digest's `keywords[]`; `count` = digests they share (after the
// B.5.1 contentHash collapse, so a forked scene counts once). Pairs stored canonically (keywordA <
// keywordB). `characterIds` is a sample of the characters in whose chats the pair appears.
export const keywordCooccurrence = sqliteTable(
  "keyword_cooccurrence",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    keywordA: text("keyword_a").notNull(), // canonical: A < B
    keywordB: text("keyword_b").notNull(),
    count: integer("count").notNull(),
    characterIds: text("character_ids", { mode: "json" }), // string[] sample (capped)
    computedAt: integer("computed_at").notNull(),
  },
  (t) => [
    uniqueIndex("keyword_cooc_unq").on(t.ownerId, t.keywordA, t.keywordB),
    index("keyword_cooc_a_idx").on(t.ownerId, t.keywordA, t.count),
    index("keyword_cooc_b_idx").on(t.ownerId, t.keywordB, t.count),
  ],
);

// Per-character keyword frequency (Pillar A companion). `count` = tier-0 digests of this character's
// chats whose `keywords[]` contains `keyword` (content-collapsed). Powers characterKeywords + the
// future tag auto-suggest (the keyword→candidate-tag path).
export const characterKeywordProfiles = sqliteTable(
  "character_keyword_profiles",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    count: integer("count").notNull(),
    computedAt: integer("computed_at").notNull(),
  },
  (t) => [
    uniqueIndex("char_kw_unq").on(t.ownerId, t.characterId, t.keyword),
    index("char_kw_char_idx").on(t.ownerId, t.characterId, t.count),
    index("char_kw_kw_idx").on(t.ownerId, t.keyword, t.count),
  ],
);

// Emergent THEMES (Pillar B — docs/planning/breadth-buildout.md B.4). k-means clusters over the tier-0
// digest embeddings surface themes nobody labeled; an LLM names each. Centroids are few (~30) and
// queried by loading directly — NO ANN index. Model-tagged (an embedder swap invalidates the clustering).
export const themeClusters = sqliteTable(
  "theme_clusters",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    model: text("model").notNull(), // embedder model that produced the clustered vectors
    clusterIdx: integer("cluster_idx").notNull(), // 0..k-1 within (owner, model)
    themeName: text("theme_name").notNull(),
    subThemes: text("sub_themes", { mode: "json" }), // string[]
    description: text("description"),
    centroid: vector32("centroid", { dim: 1024 }), // the cluster mean (loaded directly, no ANN)
    memberCount: integer("member_count").notNull(),
    computedAt: integer("computed_at").notNull(),
  },
  (t) => [uniqueIndex("theme_clusters_unq").on(t.ownerId, t.model, t.clusterIdx)],
);

// Which theme each tier-0 digest landed in (its nearest centroid). PK = digestId (one assignment per
// digest); cascades when the digest is deleted. `distance` = cosine distance to the assigned centroid.
export const digestThemeAssignments = sqliteTable(
  "digest_theme_assignments",
  {
    digestId: text("digest_id")
      .primaryKey()
      .references(() => chatDigests.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    clusterIdx: integer("cluster_idx").notNull(),
    distance: real("distance").notNull(),
    computedAt: integer("computed_at").notNull(),
  },
  (t) => [index("digest_theme_owner_cluster_idx").on(t.ownerId, t.clusterIdx)],
);
