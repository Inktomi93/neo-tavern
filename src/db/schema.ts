// Drizzle schema — the v1 spec from docs/data-model.md, machine-of-record.
// Layer rule (docs/architecture.md): `db` imports only `shared` + externals; never
// `server`/`client`. Column names are explicit snake_case (no `casing` inference —
// drizzle's casing has live bugs; explicit is deterministic).
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// libSQL NATIVE vector column. Stored as the raw little-endian Float32 blob (which IS
// libSQL's F32_BLOB on-wire format) — this avoids the drizzle `sql\`vector32()\`` insert
// caveat (#3899). The query vector is wrapped with vector32(?) in the search SQL.
const vector32 = customType<{
  data: Float32Array;
  driverData: Uint8Array;
  config: { dim: number };
}>({
  dataType(config) {
    return `F32_BLOB(${config?.dim ?? 1024})`;
  },
  toDriver(value: Float32Array): Uint8Array {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  },
  fromDriver(value: Uint8Array): Float32Array {
    // Copy into a fresh, 4-byte-aligned buffer (the driver may hand back an
    // unaligned subarray view, which Float32Array can't wrap directly).
    const bytes = Uint8Array.from(value);
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  },
});

// ───────────────────────── Tenancy ─────────────────────────
// DESIGNED multi-user, IMPLEMENTED single-user (one row). Identity =
// X-Authentik-Username, resolved at the auth seam (trusted-proxy header → that user;
// else DEFAULT_USER_HANDLE). Owned tables carry `ownerId`; scoping is enforced in the
// domain layer. assets/embeddings are global (see below).
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull().unique(), // = X-Authentik-Username
  displayName: text("display_name"),
  createdAt: integer("created_at").notNull(),
});

// Per-user config — ONE versioned blob (schemaVersion + migrate-fns), not ST's monolith.
export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  schemaVersion: integer("schema_version").notNull(),
  config: text("config", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ───────────────────────── Characters (identity / content / instance) ─────────────────────────
export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  // FK added once assets were in use (skipped in 0007). SET NULL: a deleted/GC'd avatar
  // leaves the persona intact, just avatar-less.
  avatarAssetId: text("avatar_asset_id").references((): AnySQLiteColumn => assets.id, {
    onDelete: "set null",
  }),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
});

export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    handle: text("handle").notNull().unique(), // → unique(ownerId, handle) under multi-user
    // Circular: points at the active version (which back-references this character). SET NULL
    // (a bare pointer); the version itself is RESTRICT-protected while a chat pins it.
    currentVersionId: text("current_version_id").references(
      (): AnySQLiteColumn => characterVersions.id,
      { onDelete: "set null" },
    ),
    importedFrom: text("imported_from"),
    importHash: text("import_hash"),
    starred: integer("starred", { mode: "boolean" }).default(false),
    archived: integer("archived", { mode: "boolean" }).default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("characters_owner_idx").on(t.ownerId)],
);

// Immutable content versions (copy-on-write: a version freezes once a chat pins it).
export const characterVersions = sqliteTable(
  "character_versions",
  {
    id: text("id").primaryKey(),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }), // versions die with the character
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    personality: text("personality"),
    scenario: text("scenario"),
    // All greetings unified into ONE ordered array: [0] = the primary first message (ST's
    // first_mes), the rest = alternates. Folded from the old first_message + alt_greetings — they
    // ARE the same swipeable set in ST's opening-message UI. Empty array = no seeded opening.
    greetings: text("greetings", { mode: "json" }),
    exampleMessages: text("example_messages"),
    systemPrompt: text("system_prompt"),
    postHistoryInstructions: text("post_history_instructions"),
    tags: text("tags", { mode: "json" }),
    creatorNotes: text("creator_notes"),
    // The card PNG is the avatar (one blob, both roles). FK added once assets were in use
    // (skipped in 0007). SET NULL: a GC'd/deleted asset leaves the version, just avatar-less.
    avatarAssetId: text("avatar_asset_id").references((): AnySQLiteColumn => assets.id, {
      onDelete: "set null",
    }),
    raw: text("raw", { mode: "json" }), // archival original card — never versioned/migrated
    refineryScore: real("refinery_score"),
    refineryAnalysis: text("refinery_analysis", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("character_versions_char_ver_unq").on(t.characterId, t.version)],
);

// ───────────────────────── Chats & messages ─────────────────────────
export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    // RESTRICT: can't delete a pinned version — archive the character instead.
    characterVersionId: text("character_version_id")
      .notNull()
      .references(() => characterVersions.id, { onDelete: "restrict" }),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "set null" }),
    // The persona pinned at chat open — what the CARD's {{user}} references resolve against. It
    // diverges from the (active) personaId once persona-switching lands, so switching who you play
    // mid-chat never retroactively rewrites the card's {{user}}. Null → falls back to personaId
    // (chats opened before this column / no persona chosen at open). SET NULL, like personaId.
    pinnedPersonaId: text("pinned_persona_id").references(() => personas.id, {
      onDelete: "set null",
    }),
    // The chat's default preset config for its next turn. RESTRICT preserves provenance.
    presetVersionId: text("preset_version_id").references(
      (): AnySQLiteColumn => presetVersions.id,
      { onDelete: "restrict" },
    ),
    // How this chat's NEXT turn runs (migration 0011 — supersedes the old mode/provider weld).
    // `api` = the wire protocol / runner; `source` = which credential/provider backs it.
    // resolveTurnRouting switches on (api, source) to pick the runner + env:
    //   agent-sdk        + max-pro-sub → Claude on the Max sub (free); env = buildClaudeSdkEnv
    //   agent-sdk        + openrouter  → Claude via OpenRouter's Anthropic skin (paid, same
    //                                    pipeline); env = buildClaudeOpenRouterEnv (creds firewalled)
    //   chat-completions + openrouter  → @openrouter/sdk chat.send
    //   responses        + openrouter  → @openrouter/sdk beta.responses
    // Combo validity (e.g. responses ⟹ openrouter) is enforced in the resolver/picker, not the
    // column. YGWYG is an orthogonal docs-level discipline — deliberately NOT encoded here.
    api: text("api", { enum: ["agent-sdk", "chat-completions", "responses"] })
      .notNull()
      .default("agent-sdk"),
    source: text("source", { enum: ["max-pro-sub", "openrouter"] })
      .notNull()
      .default("max-pro-sub"),
    // The chat's model for its NEXT turn — interpreted against the (api, source) catalog (a Claude
    // id from shared/models.ts for agent-sdk; an OpenRouter id from the live catalog otherwise).
    // null = fall back to the resolver's default. messages.model records what ACTUALLY ran
    // (provenance). Validation is at selection time (the picker), not on the send hot path.
    model: text("model"),
    sessionId: text("session_id"), // SDK session; null after conversion to raw / for imports
    // Compaction artifact (portable across modes). A /compact (managed or manual) captures the
    // SDK's summary here + the canon `seq` it covers (compactedAtSeq). agent-sdk handles compaction
    // natively in its session, but the STATELESS openrouter runner uses these to "pick up from the
    // compaction point": inject the summary via the {{compact_summary}} marker + rebuild history
    // from seq > compactedAtSeq. Canon (messages) is untouched — pre-compaction stays viewable.
    compactSummary: text("compact_summary"),
    compactedAtSeq: integer("compacted_at_seq"),
    // Self-ref fork link. SET NULL so a fork survives its parent's deletion.
    parentChatId: text("parent_chat_id").references((): AnySQLiteColumn => chats.id, {
      onDelete: "set null",
    }),
    convertedAt: integer("converted_at"),
    forkedAt: integer("forked_at"),
    // ST import provenance. importedFrom = the source .jsonl filename — the key that
    // resolves a branch's chat_metadata.main_chat ref → the parent chat's id (scoped to
    // the character). importHash = SHA-256 of the file bytes → idempotent re-import
    // (docker cp rewrites mtimes, so hash-not-mtime per docs/corpus-import.md).
    importedFrom: text("imported_from"),
    importHash: text("import_hash"),
    messageCount: integer("message_count").default(0),
    totalTokensIn: integer("total_tokens_in").default(0),
    totalTokensOut: integer("total_tokens_out").default(0),
    starred: integer("starred", { mode: "boolean" }).default(false),
    archived: integer("archived", { mode: "boolean" }).default(false),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("chats_owner_idx").on(t.ownerId)],
);

// Append-only canon (all modes). session_entries is the sdk-mode resume cache (below).
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }), // "nuke the chat" cleans up its messages
    seq: integer("seq").notNull(), // monotonic per-chat — canonical order + concurrency token
    // null in sdk/YGWYG (linear); reserved for raw-mode branching. Self-ref, SET NULL.
    parentId: text("parent_id").references((): AnySQLiteColumn => messages.id, {
      onDelete: "set null",
    }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    toolCalls: text("tool_calls", { mode: "json" }),
    model: text("model"),
    provider: text("provider"),
    stopReason: text("stop_reason"), // RAW provider stop string (Anthropic stop_reason / OpenAI finish_reason)
    // Normalized cross-mode finish reason (stop|length|filter|tool|other) — the queryable one
    // (providers/turn.ts normalizeFinishReason); stopReason keeps the raw value as provenance.
    finishReason: text("finish_reason"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    // Split of cacheWriteTokens by TTL bucket (result.usage.cache_creation) — sub-mode
    // defaults to the 1h bucket (measured). Lets analytics separate 5m vs 1h cache writes.
    cacheCreation5mTokens: integer("cache_creation_5m_tokens"),
    cacheCreation1hTokens: integer("cache_creation_1h_tokens"),
    costUsd: real("cost_usd"),
    // Turn-runtime metadata from the SDK result (modelUsage + result). contextWindow + the
    // running input token total drive the context-fill meter the chat UI shows; ttftMs is
    // latency UX; terminalReason/apiErrorStatus explain how a turn ended / what transient
    // errors retries survived. All nullable — populated by runChatTurn, null for imports.
    contextWindow: integer("context_window"),
    maxOutputTokens: integer("max_output_tokens"),
    ttftMs: integer("ttft_ms"),
    terminalReason: text("terminal_reason"),
    apiErrorStatus: integer("api_error_status"),
    // Immutable provenance: the preset VERSION this message was generated under. RESTRICT.
    presetVersionId: text("preset_version_id").references(
      (): AnySQLiteColumn => presetVersions.id,
      { onDelete: "restrict" },
    ),
    reasoningEffort: text("reasoning_effort"), // per-turn provenance (e.g. low|medium|high) — analytics axis
    // Generation timing (ms epoch UTC). Live sdk/raw turns don't report per-message gen timing on
    // the base row (swipes carry it on message_variants); the ST importer populates these from a
    // message's top-level gen_started/gen_finished where present. Null = not provided.
    genStarted: integer("gen_started"),
    genFinished: integer("gen_finished"),
    rawRequest: text("raw_request", { mode: "json" }), // null in sdk-mode (body not exposed)
    rawResponse: text("raw_response", { mode: "json" }),
    // Which message_variants.idx is the rendered/selected swipe. null = no variants
    // (single generation). content above is the authoritative rendered text regardless.
    activeVariantIdx: integer("active_variant_idx"),
    createdAt: integer("created_at").notNull(),
    editedAt: integer("edited_at"),
  },
  // (chat_id, seq) unique = ordering guarantee + the optimistic-concurrency dedup key.
  (t) => [uniqueIndex("messages_chat_seq_unq").on(t.chatId, t.seq)],
);

// Swipes / alternate generations at one message slot. Real ST data shows N alternates
// per slot (`swipes[]` + a parallel `swipe_info[]` where each swipe can carry its own
// model), so the faithful shape is one row per swipe — NOT parentId-siblings. Sparse:
// only messages with >1 swipe get rows. The ST importer (Phase 4) is the first writer;
// raw-mode (Phase 5) adds them live. sdk-mode never makes variants. Per-swipe model/
// timing are nullable — real data has `swipe_info` shorter than `swipes` (104 cases).
export const messageVariants = sqliteTable(
  "message_variants",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }), // swipes die with the message
    idx: integer("idx").notNull(), // position in the swipe pool (0-based)
    content: text("content").notNull(), // the swipe text, verbatim
    model: text("model"), // swipe_info[idx].extra.model
    provider: text("provider"), // swipe_info[idx].extra.api
    reasoningEffort: text("reasoning_effort"), // each swipe can differ
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    genStarted: integer("gen_started"), // ms epoch
    genFinished: integer("gen_finished"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("message_variants_msg_idx_unq").on(t.messageId, t.idx)],
);

// Durable per-chat event history (compaction / api_retry / rate_limit / status / auth_status) — the
// TurnEvent[] the runner returns, persisted so the record survives a restart (the in-memory log
// ring doesn't). METADATA only (never RP content). `at` is the event's epoch-ms; `data` is the full
// TurnEvent payload as json. messageId links to the turn's assistant message (SET NULL if it goes).
export const chatEvents = sqliteTable(
  "chat_events",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }), // events die with the chat
    messageId: text("message_id").references((): AnySQLiteColumn => messages.id, {
      onDelete: "set null",
    }),
    kind: text("kind", {
      enum: ["compaction", "api_retry", "rate_limit", "status", "auth_status"],
    }).notNull(),
    at: integer("at").notNull(), // epoch-ms UTC (TurnEvent.at)
    data: text("data", { mode: "json" }).notNull(), // the full TurnEvent payload (metadata)
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("chat_events_chat_idx").on(t.chatId, t.at)],
);

// ───────────────────────── World info (explicit attachment, never keyword-scanned) ─────────────────────────
export const worldBooks = sqliteTable("world_books", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("created_at").notNull(),
});

export const worldEntries = sqliteTable("world_entries", {
  id: text("id").primaryKey(),
  worldBookId: text("world_book_id")
    .notNull()
    .references(() => worldBooks.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  legacyKeys: text("legacy_keys", { mode: "json" }), // ST keyword triggers — import compat only, never scanned
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  priority: integer("priority").default(0),
  metadata: text("metadata", { mode: "json" }),
});

export const chatWorldEntries = sqliteTable(
  "chat_world_entries",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => worldEntries.id, { onDelete: "cascade" }),
    scope: text("scope").default("always"),
    pinned: integer("pinned", { mode: "boolean" }).default(true),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.entryId] })],
);

export const characterVersionWorldEntries = sqliteTable(
  "cv_world_entries",
  {
    characterVersionId: text("cv_id")
      .notNull()
      .references(() => characterVersions.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => worldEntries.id, { onDelete: "cascade" }),
    scope: text("scope").default("always"),
  },
  (t) => [primaryKey({ columns: [t.characterVersionId, t.entryId] })],
);

// ───────────────────────── Config, assets, search, tags ─────────────────────────
// Presets use the identity / content-version / pin triad (copy-on-write, like characters):
// editing a version no chat/message pins mutates in place; editing a pinned version forks a
// new row. This is what keeps `messages.presetVersionId` an IMMUTABLE provenance record (a
// mutable preset would silently rewrite the recorded basis of every past message). The
// identity row holds NO config — `config` + `schemaVersion` live on preset_versions.
export const presets = sqliteTable("presets", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // descriptive library label (free text), NOT a structural type
  // Circular: the active version (which back-references this preset). SET NULL (bare pointer).
  currentVersionId: text("current_version_id").references(
    (): AnySQLiteColumn => presetVersions.id,
    { onDelete: "set null" },
  ),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Immutable content versions of a preset. config = the whole sampling/scaffold bundle;
// schemaVersion = the type-2 blob-shape version (kept for migrate-fns on the config blob).
export const presetVersions = sqliteTable(
  "preset_versions",
  {
    id: text("id").primaryKey(),
    presetId: text("preset_id")
      .notNull()
      .references(() => presets.id, { onDelete: "cascade" }), // versions die with the preset
    version: integer("version").notNull(),
    config: text("config", { mode: "json" }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("preset_versions_preset_ver_unq").on(t.presetId, t.version)],
);

// App-global key/value (one-time flags etc.). Per-user prefs live in user_settings.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Global + content-addressed — NO ownerId (binaries dedup by hash). The blob lives on the
// mounted volume in a sharded CAS tree keyed by `hash` (src/server/storage/cas.ts); the row is
// metadata only. There is NO `path` column — the locator IS the hash (cas.blobPath(hash)), so a
// moved/re-rooted volume needs no DB rewrite. Bytes NEVER go in the DB. GC is mark-sweep over the
// avatar refs below (no refcount column — refcounts drift). See docs/data-model.md / docs/assets.md.
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
  ],
);

// Image vectors — a SEPARATE dimension AND vector space from the 1024-dim BGE-M3 text
// `embeddings` (do NOT reuse that column/index — mixing dims/spaces is meaningless). SigLIP-2
// so400m → 1152-dim. Keyed to a CAS asset (card PNG / avatar) and embedded FROM the blob by
// hash, never the original file. The ANN index (libsql_vector_idx) is hand-added in the
// migration (drizzle-kit can't emit it). This is the LANDING TABLE only — running the embed
// pass is a follow-up. Footgun (CLAUDE.md hard-won facts): bulk `DELETE FROM` empties the table
// and poisons the shadow index → next insert fails → `REINDEX image_embeddings_ann`.
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
  // (The libsql_vector_idx ANN index is hand-added in the migration — left out here.)
  (t) => [uniqueIndex("image_embeddings_asset_model_unq").on(t.assetId, t.model)],
);

// Chat-history MEMORY substrate — the structured per-N-turn "digest" (docs/memory.md). ONE substrate,
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
    createdAt: integer("created_at").notNull(),
  },
  // One digest per (chat, tier, block) — idempotent upsert + targeted regeneration.
  // (The libsql_vector_idx ANN index `chat_digests_ann` is hand-added in the migration — left out
  // here, like image_embeddings_ann; drizzle-kit can't emit it.)
  (t) => [
    uniqueIndex("chat_digests_chat_tier_block_unq").on(t.chatId, t.tier, t.blockIdx),
    index("chat_digests_owner_idx").on(t.ownerId),
  ],
);

// Chat-history SEGMENT layer — the raw-verbatim half of the hybrid corpus search (docs/memory.md
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
    createdAt: integer("created_at").notNull(),
  },
  // One segment per (chat, block) — idempotent upsert + targeted regeneration. (The libsql_vector_idx
  // ANN index `chat_segments_ann` is hand-added in the migration — drizzle-kit can't emit it.)
  (t) => [
    uniqueIndex("chat_segments_chat_block_unq").on(t.chatId, t.blockIdx),
    index("chat_segments_owner_idx").on(t.ownerId),
  ],
);

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull().unique(), // → unique(ownerId, name) under multi-user
  color: text("color"),
  source: text("source", { enum: ["manual", "auto"] }).default("manual"),
});

export const characterTags = sqliteTable(
  "character_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.tagId, t.characterId] })],
);

export const chatTags = sqliteTable(
  "chat_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.tagId, t.chatId] })],
);

export const worldBookTags = sqliteTable(
  "world_book_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    worldBookId: text("world_book_id")
      .notNull()
      .references(() => worldBooks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.tagId, t.worldBookId] })],
);

export const personaTags = sqliteTable(
  "persona_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.tagId, t.personaId] })],
);

export const presetTags = sqliteTable(
  "preset_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    presetId: text("preset_id")
      .notNull()
      .references(() => presets.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.tagId, t.presetId] })],
);

// ───────────────────────── SDK session persistence (the DbSessionStore substrate) ─────────────────────────
// The raw SDK transcript, stored opaquely for `resume`. SEPARATE from `messages` (our
// clean canon). sdk-mode only; regenerable-ish from messages.
export const sessionEntries = sqliteTable(
  "session_entries",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }), // resume cache dies with the chat
    sessionId: text("session_id").notNull(), // SDK session id (== chats.session_id)
    subpath: text("subpath"), // SessionKey.subpath (subagents); "" = main transcript (NOT null — null defeats the uuid unique-index dedup; see store.ts)
    seq: integer("seq").notNull(), // append order
    uuid: text("uuid"), // SDK entry uuid — idempotency key (nullable: titles/tags have none)
    type: text("type").notNull(),
    entry: text("entry", { mode: "json" }).notNull(), // the raw frame, opaque
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("session_entries_load_idx").on(t.sessionId, t.subpath, t.seq),
    // backs append()'s upsert/dedup (SDK replays uuids on retry / importSessionToStore)
    uniqueIndex("session_entries_uuid_unq")
      .on(t.sessionId, t.subpath, t.uuid)
      .where(sql`${t.uuid} is not null`),
  ],
);
