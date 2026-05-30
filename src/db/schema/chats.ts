import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { characterVersions, personas } from "./characters";
import { presetVersions } from "./config";
import { users } from "./tenancy";

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
    // (docker cp rewrites mtimes, so hash-not-mtime per docs/subsystems/corpus-import.md).
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
