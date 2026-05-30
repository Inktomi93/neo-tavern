import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { assets } from "./assets";
import { characters, characterVersions } from "./characters";
import { chats } from "./chats";
import { vector32 } from "./custom-types";
import { users } from "./tenancy";

export const characterEmbeddings = sqliteTable(
  "character_embeddings",
  {
    id: text("id").primaryKey(),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    // The version whose card was embedded — provenance; a re-embed after a version bump updates the row.
    characterVersionId: text("character_version_id")
      .notNull()
      .references(() => characterVersions.id, { onDelete: "restrict" }),
    model: text("model").notNull(), // embedder model — tags the vector space (a swap = re-index)
    embedding: vector32("embedding", { dim: 1024 }),
    hubScore: real("hub_score"),
    sourceText: text("source_text"),
    tokens: integer("tokens"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("character_embeddings_character_model_unq").on(t.characterId, t.model),
    index("character_embeddings_owner_idx").on(t.ownerId),
    // libSQL native ANN index. Declared as an expression index (drizzle-kit ≥0.31 emits this);
    // it lands in the generated migration like any other index. The literal column name (not
    // `${t.embedding}`) keeps the DDL un-qualified, which CREATE INDEX requires.
    index("character_embeddings_ann").on(sql`libsql_vector_idx(embedding)`),
  ],
);

// Image vectors — a SEPARATE dimension AND vector space from the 1024-dim BGE-M3 text
// `embeddings` (do NOT reuse that column/index — mixing dims/spaces is meaningless). SigLIP-2
// so400m → 1152-dim. Keyed to a CAS asset (card PNG / avatar) and embedded FROM the blob by
// hash, never the original file. The ANN index (libsql_vector_idx) is declared below as an
// expression index. This is the LANDING TABLE only — running the embed pass is a follow-up. To
// clear it safely use `clearVectorTable` (drop→delete→recreate) — a bare bulk `DELETE FROM`
// poisons the DiskANN shadow table; `reindexAnn` / the boot health check recover a poisoned one.
export const imageEmbeddings = sqliteTable(
  "image_embeddings",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }), // the vector dies with its asset
    model: text("model").notNull(), // e.g. onnx-community/siglip2-so400m — tags the space (a swap = re-index)
    embedding: vector32("embedding", { dim: 1152 }),
    createdAt: integer("created_at").notNull(),
  },
  // One vector per (asset, model) — makes the (future) embed pass idempotent + upsertable.
  (t) => [
    uniqueIndex("image_embeddings_asset_model_unq").on(t.assetId, t.model),
    index("image_embeddings_ann").on(sql`libsql_vector_idx(embedding)`),
  ],
);

// Chat-history MEMORY substrate — the structured per-N-turn "digest" (docs/subsystems/chat-memory.md). ONE substrate,
// two scopes: (1) within-chat memory injection (per-chat exact in-process cosine — never the global
// ANN); (2) cross-chat, per-user corpus search (the hand-added `chat_digests_ann` index). Derived,
// regenerable from canon (messages) — NOT the polymorphic `embeddings` table, so it gets real FKs:
// nuke-the-chat cascades its digests away. tier 0 = per-block; tier 1+ = consolidation (digest-of-
// digests, seed-promoted) so the injected story-so-far stays budget-bounded as a chat grows.
export const chatDigests = sqliteTable(
  "chat_digests",
  {
    id: text("id").primaryKey(),
    // Cascade: "nuke the chat" cleans up its digests. A fork gets a new chatId → its digests rebuild
    // lazily under the new key (we never copy digest rows across a fork).
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    // Denormalized from the chat (stable per chat) so per-user corpus search is a column filter, not
    // a join. Mirrors chats.ownerId (+ its index).
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    // The chat's PINNED character version — provenance + "by character" corpus scoping (resolve
    // characterId via the join). RESTRICT mirrors chats.characterVersionId (a digest cascades away
    // with its chat long before this could block a version delete).
    characterVersionId: text("character_version_id")
      .notNull()
      .references(() => characterVersions.id, { onDelete: "restrict" }),
    tier: integer("tier").notNull().default(0), // 0 = per-block digest; 1+ = consolidation tier
    blockIdx: integer("block_idx").notNull(), // ordinal within (chatId, tier)
    // The canon span this digest covers (messages.seq). Links every digest back to its exact raw
    // messages (verbatim click-through); also the staleness key (a contained message edited after
    // createdAt ⇒ stale). For tier 1+, the union span of the consolidated children.
    seqStart: integer("seq_start").notNull(),
    seqEnd: integer("seq_end").notNull(),
    text: text("text").notNull(), // the structured digest body (topic-anchor first line + facts)
    topicAnchor: text("topic_anchor"), // the `[entities — scene]` first line, denormalized for display/filter
    keywords: text("keywords", { mode: "json" }), // string[] — concrete, scene-specific match keys
    model: text("model").notNull(), // embedder model — tags the vector space (a swap = re-index)
    summarizerModel: text("summarizer_model"), // provenance: which summarizer authored this digest
    // Always populated (digests must be corpus-searchable); memory's own Mix-A read ignores it.
    embedding: vector32("embedding", { dim: 1024 }),
    hubScore: real("hub_score"), // CSLS hubness per (entity, model) — null until `pnpm csls`
    tokens: integer("tokens"), // digest token count (Mix-A budget accounting)
    // sha256 of the SOURCE span (rendered raw transcript of seqStart..seqEnd), NOT the LLM digest text
    // (non-deterministic). Fork/import duplication-collapse key for cross-chat search + all-pairs
    // analytics (docs/planning/breadth-buildout.md B.5.1). Null for tier 1+ consolidations (no single
    // raw source) and for any pre-backfill row.
    contentHash: text("content_hash"),
    createdAt: integer("created_at").notNull(),
  },
  // One digest per (chat, tier, block) — idempotent upsert + targeted regeneration.
  (t) => [
    uniqueIndex("chat_digests_chat_tier_block_unq").on(t.chatId, t.tier, t.blockIdx),
    index("chat_digests_owner_idx").on(t.ownerId),
    // Group-by-content within an owner (the dedup collapse) is a covered scan.
    index("chat_digests_content_idx").on(t.ownerId, t.contentHash),
    index("chat_digests_ann").on(sql`libsql_vector_idx(embedding)`),
  ],
);

// Chat-history SEGMENT layer — the raw-verbatim half of the hybrid corpus search (docs/subsystems/chat-memory.md
// §4). First-class sibling of `chat_digests`, sharing the SAME per-block boundary (blockIdx /
// seqStart..seqEnd) so a block's digest (structured) and segment (raw) link 1:1. Where digests are
// the precision/theme substrate, segments preserve the exact phrasing — "find the moment X said Y".
// Replaces the old import-only polymorphic `chat_segment` (no FKs, stale for live chats): this is
// FK'd, owner-scoped, and refreshed incrementally as chats proceed (embed-only — no summarizer).
// Indexed across the WHOLE chat (not just the aged-out window — the search tool wants everything
// findable, unlike in-chat memory injection which scopes to one chat's aged digests). No tiers —
// raw text isn't consolidated (that's what digests are for).
export const chatSegments = sqliteTable(
  "chat_segments",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    // Denormalized (stable per chat) — cross-chat corpus search filters by owner as a WHERE.
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    // The chat's pinned character version — "by character" corpus scoping (resolve characterId via
    // the join). RESTRICT mirrors chats/chat_digests; a segment cascades away with its chat first.
    characterVersionId: text("character_version_id")
      .notNull()
      .references(() => characterVersions.id, { onDelete: "restrict" }),
    blockIdx: integer("block_idx").notNull(), // same blockSize boundary as the block's digest
    seqStart: integer("seq_start").notNull(), // canon span — verbatim click-through + staleness key
    seqEnd: integer("seq_end").notNull(),
    text: text("text").notNull(), // the block's raw messages, verbatim ("Speaker: text" joined)
    model: text("model").notNull(), // embedder model — tags the vector space (a swap = re-index)
    embedding: vector32("embedding", { dim: 1024 }),
    hubScore: real("hub_score"), // CSLS hubness per (entity, model) — null until computed
    tokens: integer("tokens"),
    // sha256 of the rendered raw block text (== the embedded `text`). Fork/import duplication-collapse
    // key for cross-chat search + all-pairs analytics (docs/planning/breadth-buildout.md B.5.1). Null
    // only for pre-backfill rows.
    contentHash: text("content_hash"),
    createdAt: integer("created_at").notNull(),
  },
  // One segment per (chat, block) — idempotent upsert + targeted regeneration.
  (t) => [
    uniqueIndex("chat_segments_chat_block_unq").on(t.chatId, t.blockIdx),
    index("chat_segments_owner_idx").on(t.ownerId),
    // Group-by-content within an owner (the dedup collapse) is a covered scan.
    index("chat_segments_content_idx").on(t.ownerId, t.contentHash),
    index("chat_segments_ann").on(sql`libsql_vector_idx(embedding)`),
  ],
);
