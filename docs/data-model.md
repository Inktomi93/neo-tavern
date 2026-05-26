# Data model (v1 spec)

The canonical v1 database schema, preserved from the original brief so it isn't
lost. **This is the spec, not the implementation** — Phase 2 implements it in
`src/db/schema.ts` (which, per the layer cake, imports only Drizzle + `shared`;
see `docs/architecture.md`). Zod schemas at the edges live in `src/shared/schemas/`
and should stay aligned with these tables.

Conventions: `id` = text (nanoid). Timestamps = integer (unix epoch ms). JSON
columns use Drizzle `{ mode: 'json' }`. Enums = text with an `enum` constraint.

## Schema

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';

// Tenancy: DESIGNED multi-user, IMPLEMENTED single-user (one row). Identity =
// X-Authentik-Username, resolved at one auth seam (trusted-proxy header → that user;
// else DEFAULT_USER_HANDLE). See the "Multi-user / tenancy" + "Versioning" notes below.
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  handle: text('handle').notNull().unique(), // = X-Authentik-Username
  displayName: text('display_name'),
  createdAt: integer('created_at').notNull(),
});

// Per-user config — ONE versioned blob, not ST's 503KB monolith. schemaVersion +
// pure migrate-fns = a deterministic upgrade path (no duck-typed `?? default`).
export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id').primaryKey().references(() => users.id),
  schemaVersion: integer('schema_version').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const personas = sqliteTable('personas', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  description: text('description').notNull(),
  avatarAssetId: text('avatar_asset_id'),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at').notNull(),
});

export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  handle: text('handle').notNull().unique(), // → unique(ownerId, handle) under multi-user
  currentVersionId: text('current_version_id'),
  importedFrom: text('imported_from'),
  importHash: text('import_hash'),
  starred: integer('starred', { mode: 'boolean' }).default(false),
  archived: integer('archived', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at').notNull(),
});

export const characterVersions = sqliteTable('character_versions', {
  id: text('id').primaryKey(),
  characterId: text('character_id').notNull(),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  personality: text('personality'),
  scenario: text('scenario'),
  // migration 0009: first_message + alt_greetings folded into ONE ordered array, [0] = the
  // primary first message (ST first_mes), rest = alternates — they're the same swipeable opening
  // set in ST. Importer builds [first_mes, ...alternate_greetings] (empties dropped); seeding (later)
  // makes greetings[0] the opening message with the rest as message_variants. [] = no seeded opening.
  greetings: text('greetings', { mode: 'json' }),
  exampleMessages: text('example_messages'),
  systemPrompt: text('system_prompt'),
  postHistoryInstructions: text('post_history_instructions'),
  tags: text('tags', { mode: 'json' }),
  creatorNotes: text('creator_notes'),
  avatarAssetId: text('avatar_asset_id'),
  raw: text('raw', { mode: 'json' }),
  refineryScore: real('refinery_score'),
  refineryAnalysis: text('refinery_analysis', { mode: 'json' }),
  createdAt: integer('created_at').notNull(),
});

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  characterVersionId: text('character_version_id').notNull(), // → character_versions.id (RESTRICT)
  personaId: text('persona_id'), // → personas.id (SET NULL)
  presetVersionId: text('preset_version_id'), // → preset_versions.id (RESTRICT); 0007 rename
  // YGWYG mode
  mode: text('mode', { enum: ['sdk', 'raw'] }).notNull().default('sdk'),
  provider: text('provider').notNull(), // 'anthropic-sdk' | 'anthropic-direct' | 'openrouter'
  model: text('model'), // 0010 — the chat's model for its NEXT turn (mode-agnostic: an sdk Claude id
  // OR a raw OpenRouter id). null → mode default in resolveTurnRouting. messages.model = provenance.
  sessionId: text('session_id'), // null after conversion to raw or for imports
  parentChatId: text('parent_chat_id'), // set when this chat is a fork
  convertedAt: integer('converted_at'),
  forkedAt: integer('forked_at'),
  // Aggregates
  messageCount: integer('message_count').default(0),
  totalTokensIn: integer('total_tokens_in').default(0),
  totalTokensOut: integer('total_tokens_out').default(0),
  starred: integer('starred', { mode: 'boolean' }).default(false),
  archived: integer('archived', { mode: 'boolean' }).default(false),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  // Monotonic per-chat ordering — THE canonical sort key. Don't trust createdAt
  // (ms collisions; doesn't encode intended order). Also the fork/swipe anchor.
  seq: integer('seq').notNull(),
  // Linear in YGWYG mode (no parent_id needed), set in raw mode if swipes used
  parentId: text('parent_id'),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),
  toolCalls: text('tool_calls', { mode: 'json' }),
  model: text('model'),
  provider: text('provider'),
  stopReason: text('stop_reason'), // result.stop_reason — why generation ended
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  // Turn-runtime metadata from the SDK result (migration 0008). cacheWrite split by TTL
  // bucket (sub-mode defaults 1h); contextWindow + maxOutputTokens drive the context-fill
  // meter; ttftMs is latency UX; terminalReason/apiErrorStatus = how a turn ended / what
  // transient errors retries survived. All nullable — set by runChatTurn, null for imports.
  cacheCreation5mTokens: integer('cache_creation_5m_tokens'), // 0008
  cacheCreation1hTokens: integer('cache_creation_1h_tokens'), // 0008
  contextWindow: integer('context_window'), // 0008
  maxOutputTokens: integer('max_output_tokens'), // 0008
  ttftMs: integer('ttft_ms'), // 0008
  terminalReason: text('terminal_reason'), // 0008 — SDK TerminalReason
  apiErrorStatus: integer('api_error_status'), // 0008 — transient HTTP status retries recovered from
  costUsd: real('cost_usd'), // result.modelUsage[].costUSD — for the analytics layer
  presetVersionId: text('preset_version_id'), // → preset_versions.id (RESTRICT, immutable provenance); 0007
  reasoningEffort: text('reasoning_effort'), // per-turn provenance (low|medium|high|…) — 0007; analytics axis
  rawRequest: text('raw_request', { mode: 'json' }), // null in sdk-mode (body not exposed)
  rawResponse: text('raw_response', { mode: 'json' }),
  createdAt: integer('created_at').notNull(),
  editedAt: integer('edited_at'),
});

export const worldBooks = sqliteTable('world_books', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: integer('created_at').notNull(),
});

export const worldEntries = sqliteTable('world_entries', {
  id: text('id').primaryKey(),
  worldBookId: text('world_book_id').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  legacyKeys: text('legacy_keys', { mode: 'json' }), // import compat only
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  priority: integer('priority').default(0),
  metadata: text('metadata', { mode: 'json' }),
});

export const chatWorldEntries = sqliteTable('chat_world_entries', {
  chatId: text('chat_id').notNull(),
  entryId: text('entry_id').notNull(),
  scope: text('scope').default('always'),
  pinned: integer('pinned', { mode: 'boolean' }).default(true),
}, (t) => ({ pk: primaryKey({ columns: [t.chatId, t.entryId] }) }));

export const characterVersionWorldEntries = sqliteTable('cv_world_entries', {
  characterVersionId: text('cv_id').notNull(),
  entryId: text('entry_id').notNull(),
  scope: text('scope').default('always'),
}, (t) => ({ pk: primaryKey({ columns: [t.characterVersionId, t.entryId] }) }));

// Presets use the identity / content-version / pin triad (copy-on-write, like characters) —
// migration 0007. config + schemaVersion live on preset_versions, so messages.presetVersionId
// is an IMMUTABLE provenance record (a mutable preset would rewrite past generation history).
// The `config` blob IS the prompt structure: a `PromptConfig` (shared/prompt-config.ts) — a
// reordered list of sections (literal blocks + character/persona/world_info markers + a cache
// `boundary`) + params, validated by zod, evolved via schemaVersion lift-fns (no DB migration).
// `assemblePrompt` (shared/prompt-assemble.ts) renders it against a chat into the static (cached)
// + dynamic system-prompt halves. Persona pin is native: chats.personaId resolves `{{user}}` in
// card-derived sections (pinned) vs user-authored sections (active) — no card mutation. The
// prompt structure lives in the blob (NOT normalized section rows) precisely because the version
// must be an immutable snapshot — mutating a shared section row would corrupt past provenance.
export const presets = sqliteTable('presets', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // descriptive library label (free text), NOT a structural type
  currentVersionId: text('current_version_id'), // → preset_versions.id (SET NULL, circular)
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const presetVersions = sqliteTable('preset_versions', {
  id: text('id').primaryKey(),
  presetId: text('preset_id').notNull(), // → presets.id (CASCADE)
  version: integer('version').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  schemaVersion: integer('schema_version').notNull().default(1), // config-blob upgrade path
  createdAt: integer('created_at').notNull(),
}); // UNIQUE(presetId, version)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  hash: text('hash').notNull().unique(),
  uploadedAt: integer('uploaded_at').notNull(),
});

export const embeddings = sqliteTable('embeddings', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  model: text('model').notNull(),
  // ✅ DONE — Phase 3a (migration 0001). In src/db/schema.ts the native libSQL vector
  // is a `vector32` customType emitting `F32_BLOB(1024)`: toDriver stores the RAW
  // little-endian Float32 blob (dodges the drizzle #3899 `sql`vector32()`` insert
  // caveat); fromDriver → Float32Array (copy to a fresh aligned buffer). The ANN index
  // is HAND-ADDED to migration 0001 (drizzle-kit can't emit it):
  //   CREATE INDEX embeddings_ann ON embeddings (libsql_vector_idx(embedding));
  // Search (domain/search): vector_top_k('embeddings_ann', vector32(?), k) JOIN
  // embeddings ON rowid, then ORDER BY vector_distance_cos (exact re-rank). Embedder =
  // BGE-M3 ("Xenova/bge-m3", CLS pooling, normalized, 1024-dim) in embeddings/embedder
  // (CPU ONNX; device:"cuda" flip later). NOTE: embeddings is global (no ownerId) —
  // owner-scope search results when multi-user + real data land.
  embedding: vector32('embedding', { dim: 1024 }),
  // CSLS hubness (migration 0005, Phase 4.6.3a): mean cosine-sim to the K=10 nearest
  // SAME-(entity_type, model) neighbours, precomputed at index time by `pnpm csls`
  // (domain/corpus/hubness). null until computed. Query-time re-rank in domain/search:
  // adjusted_dist = max(0, dist - 1 + hub_score), demoting "matches-everything" hubs.
  hubScore: real('hub_score'),
  // The literal text that was embedded (migration 0006, Phase 4.6.3b): the two-stage
  // cross-encoder reranker scores (query, source_text) pairs; reconstructing segment text
  // at query time would mean re-segmenting whole chats. null on rows embedded before 0006;
  // filled by the embed pass + `pnpm corpus:backfill-source-text`.
  sourceText: text('source_text'),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at').notNull(),
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull().unique(), // → unique(ownerId, name) under multi-user
  color: text('color'),
  source: text('source', { enum: ['manual', 'auto'] }).default('manual'),
});

export const taggables = sqliteTable('taggables', {
  tagId: text('tag_id').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.tagId, t.entityType, t.entityId] }) }));
```

## Design notes (the why)

- **Character versioning (identity / content / instance).** `characters` is the
  stable identity (immutable `id`, rename-able `handle`, starred, archived); the
  content lives in immutable `character_versions` (`currentVersionId` points at the
  active one); a `chat` pins ONE version via `chats.characterVersionId`. This is the
  whole answer to ST's "the PNG filename *is* the character" — identity, content, and
  the instance that ran a given version are three separate things. It lets the
  refinery (Score → Rewrite → Analyze) mint versions while preserving history
  (`refineryScore` / `refineryAnalysis` ride on the version), and it's what makes the
  cards queryable for the analytics layer at all.
  - **Increment policy = copy-on-write.** A version becomes immutable the moment any
    chat pins it. Editing a version no chat references mutates it in place (drafts
    don't spam versions); editing a pinned version forks a new row (`version = max+1`)
    and repoints `currentVersionId`. Chats keep their pinned version, so editing a
    character never rewrites past canon — and in `sdk` mode the version is already
    baked into the session at start, so an edit can't disturb an in-flight chat.
- **World Info is explicit attachment with a per-entry `scope`** (refines the earlier
  "never keyword-scanned" stance — *basic* keyword is now in). `chat_world_entries` /
  `cv_world_entries` attach entries — the **candidate pool** (we never scan *unattached*
  entries, unlike ST's bound-world scan). `scope` decides activation AND placement:
  - **`always`** (default) → the **static** (cached) system prompt — byte-stable, paid once.
  - **`keyword`** → matched against recent messages by the entry's keys (basic, case-insensitive,
    whole-word; `world_entries.legacyKeys` is the imported seed → promote to an active key list),
    injected into the **dynamic** system prompt on a hit (so the per-turn set never busts the
    cached static prefix). So no separate `position` column is needed — `scope` *is* the placement.

  Deliberately NOT ST (slop guard): no secondary-key AND/NOT logic, recursion, min-activations,
  timed effects (sticky/cooldown/delay), probability, inclusion groups, or floating `atDepth`
  placement. Schema delta when built: add `'keyword'` to the `scope` enum + an active `keys` list;
  `priority`/`enabled` already exist.
- **`messages` is the source of truth; `session_entries` is an sdk-mode resume cache.**
  `messages` is the clean canon for **all** modes (display, search, analytics); the
  raw SDK transcript in `session_entries` exists only in sdk-mode, only to feed
  `resume`, and is regenerable-ish from `messages` (so if they ever diverge, `messages`
  wins). `seq` — not `createdAt` — is the canonical order. **Swipes/variants = a `message_variants`
  child table** (decided against `parentId`-siblings): real ST data shows swipes as N
  alternates at one slot — `swipes[]` + a parallel `swipe_info[]` where *each swipe can
  carry its own model* — so the faithful shape is `message_variants(message_id, idx,
  content, model, provider, tokens_in/out, gen_started/finished)` + `messages.activeVariantIdx`
  (**built Phase 4** — the ST importer is the first writer, since real chats are swipe-heavy:
  42% of messages carry alternates; raw mode in Phase 5 adds them live; sdk-mode never makes
  variants). `parentId` is reserved for future in-chat branching. See `docs/corpus-import.md`
  for the ST→variant mapping.
  Because sdk-mode is **stateless** (a fresh `query({resume})` per message),
  `result.usage` is per-turn, so `tokensIn/Out` + `cacheRead/WriteTokens` + `costUsd`
  are a direct copy — no cumulative differencing (a warm session would need it). These
  feed the analytics layer (the actual product). `session_entries.subpath` stores **`""`**
  (not NULL) for the main transcript: the uuid-dedup unique index `(session_id, subpath,
  uuid) WHERE uuid IS NOT NULL` is defeated by a NULL `subpath` (SQLite treats every NULL
  as distinct, so replayed uuids wouldn't dedup); `""` keeps the idempotency honest. The
  store persists **every** frame the SDK emits and replays them in `seq` order, so resume
  works across compaction. MEASURED (`pnpm sdk:compaction`): a compaction persists a
  `system`/`compact_boundary` marker (resets the chain root, `parentUuid:null`) **+ a synthetic
  `user` frame holding an LLM summary** — NOT a `preserved_messages` relink (absent in practice).
  Old frames stay; resume uses the compacted state. Caveat: the SDK summary points the model at a
  `/tmp` transcript it can't read with `tools:[]`, so detail recall degrades — long-RP fidelity
  wants owned context (see `docs/sdk-notes.md`).
- **Concurrency & live sync (multi-device, same chat — expected for one user on phone +
  desktop).** **IMPLEMENTATION STATUS (be honest — partially built):**
  - **✅ BUILT:** the optimistic `seq` guard + the in-process per-chat lock. A send carries the
    client's last-seen tip (`expectedSeq`); if `MAX(seq) ≠ expectedSeq` `domain/chat` send
    returns **`status:"stale"` + the full current messages + `latestSeq`, and does NOT run
    generation** — so a stale device (phone→desktop without refreshing) can never inject an
    incoherent turn, and it gets everything to reconcile. The **per-chat turn lock** is an
    in-process mutex (`_shared/lock.ts` `withChatLock`) — one in-flight generation per chat,
    so two concurrent `resume`s can't corrupt `session_entries`. (Tested:
    `tests/integration/chat.test.ts` stale-seq case proves the model isn't called.)
  - **✅ BUILT: atomic send on failure.** A failed generation (typed `ClaudeTurnError` from
    the provider — `kind` ∈ rate_limit/auth_failed/billing/…) **rolls the user message back
    out** and returns `status:"error" + {code, retryable, resetsAt?}`, so the chat stays at
    its prior coherent tip and the client can surface a typed reason + re-send. `code` is the
    **provider-agnostic** vocabulary raw-mode reuses in Phase 5.
  - **⏭ DEFERRED (designed, NOT built):** **live push** — a tRPC v11 subscription (SSE) →
    TanStack Query invalidation so the other device auto-refreshes without a manual reload.
    Today it's *reconcile-on-send* (you learn you're stale when you send, then re-send), not
    seamless real-time sync. Also deferred: **fork** (`parentChatId` branch from `expectedSeq`
    — the schema supports it, no endpoint yet) and the **multi-instance turn lock**
    (`chats.generatingSince` + timeout — the in-process mutex covers single-instance, which is
    what we run). Append-only + libSQL single-writer already means a stale write can never
    *lose* the other device's turns; only ordering/coherence is at stake, which `seq` guards.
  - The stateless/no-session design *enables* the deferred live-push (no session affinity to
    coordinate — the exact thing that was painful in st-bridge). When built: SSE deployment
    disables proxy buffering (caddy auto-flushes `text/event-stream`) + `: ping` keep-alives
    (~20s) so h2/h3 idle timeouts don't drop an idle stream.
- **Chat mode / provider / session / fork.** `mode` = `sdk` | `raw`; `provider` =
  `anthropic-sdk` | `anthropic-direct` | `openrouter`; `model` = the model for the chat's
  NEXT turn (mode-agnostic; null → mode default); `sessionId` = the Agent SDK session (null
  after conversion to raw, or for imports); `parentChatId` + `forkedAt` + `convertedAt` track
  the one-way escape valve. Aggregates exist for fast analytics without scanning all messages.
  **`mode`/`provider`/`model` are the chat's NEXT-turn routing config; `messages.*` records what
  ACTUALLY ran (provenance).** `domain/chat/routing.ts` `resolveTurnRouting(chat, config)` is the
  **single owner** of model+provider selection — `send()` calls it and branches the runner
  (`runChatTurn` / `runRawTurn`); nothing hardcodes a model. Model *validity* is checked at
  selection time (the picker), not on the send hot path. raw-mode provider-routing prefs ride in
  `chats.metadata` (slop guard — promote to a column if earned) → the Responses `provider` field.
- **Embeddings = libSQL native vectors** (spike-validated; see `build-plan.md`).
  `embeddings` rows are polymorphic (`entityType`/`entityId` — a character version,
  a message, …) and hold the vector directly in an `F32_BLOB(1024)` column with a
  `libsql_vector_idx` ANN index — **no sqlite-vec extension, no `vec0` table.**
  `1024` matches **BGE-M3** (default); the `model` column + the column dimension are
  the only things that change if we switch to Qwen3-Embedding.
- **Assets are content-addressed.** `hash` is unique; binaries (avatars, the imported
  card PNGs) live on the mounted volume and are referenced by hash; the DB row is
  metadata only (caddy serves them statically, identical images dedup by hash). Image
  **bytes never go in the DB.** Image **analysis** (cardcurator-style) is a separate
  axis and a **batch/import job, not a hot path** — the derived signal lands in the DB
  (vision tags → `taggables`, themes → `refineryAnalysis`, visual embeddings →
  `embeddings`), the bytes do not. Analyzing 400 cards is a one-time background pass;
  the "perf" worry conflates that with a per-request blob read.
- **Tags are polymorphic** (`taggables` over any entity), `manual` or `auto` (the
  latter for theme-clustering output).
- `presets` (kind + JSON config) and `settings` (key/JSON value) are config blobs.
- **Multi-user: designed, single-user implemented.** Every top-level *owned* entity
  carries `ownerId → users.id` (personas, characters, chats, presets, world_books,
  tags); children inherit ownership via their parent (messages/session_entries ← chat,
  versions ← character, embeddings ← entity, world_entries ← world_book). **`assets`
  are global + content-addressed + refcounted — NO `ownerId`** (binaries dedup by hash;
  reaped when unreferenced). Scoping is **enforced in the `domain/*` repository layer**
  (every read/write bakes `WHERE owner_id = ctx.user.id`), exercised even with one user,
  so a second user is a no-op not a rewrite. Global uniques become composite under
  multi-user (`unique(ownerId, handle)` on characters, `(ownerId, name)` on tags).
  Identity = `X-Authentik-Username` at one auth seam: **trusted-proxy header → that
  user; else `DEFAULT_USER_HANDLE`** (so direct-LAN/IP access = the owner, by design).
  No session, no CSRF (stateless per-request); the header is believed **only from
  caddy** (verified via an `X-Neo-Proxy` shared secret; caddy strips client copies).
  Deployment invariant: don't expose port 8788 to an untrusted network.
- **Versioning — three kinds, don't conflate (and don't version everything):**
  (1) **table/column shape → Drizzle migrations** (the migration history *is* the
  version; every table gets it free, no per-table version column);
  (2) **JSON-blob shape → an explicit `schemaVersion` + pure migrate-fns**, but ONLY for
  blobs read *structurally* that *evolve* — `user_settings.config`, `preset_versions.config`
  (load → if `schemaVersion < current`, migrate → Zod-validate → write back); this
  replaces ST's scattered `if (x === undefined)` duck-typing;
  (3) **domain/content → `character_versions.version` AND `preset_versions.version`** (canon
  history). **Presets are type-3 as of migration 0007** (a `presets`/`preset_versions` triad,
  copy-on-write like characters): a mutable preset would silently rewrite the recorded basis of
  every past message (`messages.presetVersionId`), breaking corpus analytics — exactly what
  content-versioning prevents. `schemaVersion` (the type-2 blob-shape version) rides along on
  `preset_versions`. Opaque/archival blobs (`character_versions.raw`, `messages.rawRequest/
  rawResponse`, `chats.metadata`) are write-once — **not versioned.** Discriminator:
  *do I parse this on read AND will its shape change?* yes → version; column →
  migrations cover it; archival → leave it.
- **Referential integrity — enforced FKs (migration 0007).** Internal links are real foreign
  keys with an explicit cascade policy (before 0007 only `ownerId → users` existed; internal
  links were plain text). The shape: **CASCADE** down ownership/containment (a deleted chat takes
  its messages/variants/session_entries/junctions; a deleted character takes its versions; a
  deleted preset takes its versions); **RESTRICT** on provenance pins (`chats.characterVersionId`,
  `chats`/`messages.presetVersionId`) so you can't delete a version a chat/message pinned — the
  intended effect is that deleting a character/preset *with chats* fails atomically (CASCADE→version
  hits the RESTRICT), enforcing **archive-don't-delete**; **SET NULL** for the circular
  `currentVersionId` pointers and optional refs (`chats.personaId`, self-ref `parentChatId`/
  `parentId`). Polymorphic refs (`embeddings.(entityType,entityId)`, `taggables.(entityType,
  entityId)`) genuinely cannot be FKs and stay plain text. Verified on the real corpus:
  `PRAGMA foreign_key_check` returns zero rows after `pnpm import:st`.

## Importing from SillyTavern (validated against real cards + chats)

Verified against a real card ("Block of Cheese", a V3 card) and its chat logs.

### Character card (PNG)

The card JSON is base64 in PNG `tEXt` chunks — keyword **`chara`** (V2) and/or
**`ccv3`** (V3, fields under `.data`). Prefer `ccv3` when present. Field map → `character_versions`:

| Card field | Column |
| --- | --- |
| `name` | `name` |
| `description` | `description` |
| `personality` | `personality` |
| `scenario` | `scenario` |
| `first_mes` + `alternate_greetings` | `greetings[]` (folded — `[first_mes, ...alternates]`, empties dropped) |
| `mes_example` | `exampleMessages` |
| `system_prompt` | `systemPrompt` |
| `post_history_instructions` | `postHistoryInstructions` |
| `tags` | `tags` |
| `creator_notes` | `creatorNotes` |
| `extensions.depth_prompt` | author's note seed |
| (whole card JSON) | `raw` · `importHash` = hash of the card |

### Chat JSONL

Line 0 = metadata: `{ chat_metadata: { note_prompt, note_interval, note_position,
note_depth, note_role, timedWorldInfo, variables }, user_name, character_name }`
(`note_*` → the author's-note system message). Subsequent lines = messages:
`{ name, is_user, is_system, send_date, mes, extra, swipes, swipe_id, swipe_info }`.

- `is_user:true` → `role:"user"`; `is_user:false` → `"assistant"`; `is_system` → `"system"`.
- `mes` → `content`; `send_date` → `createdAt`; `extra` (model/tokens) → `model`/token columns.
- **`swipes` / `swipe_id`** = alternate generations. **All swipes → `message_variants`**
  (one row each, verbatim), with `messages.activeVariantIdx = swipe_id` and
  `messages.content = mes` (the *rendered* text — authoritative). Note `mes` can diverge
  from `swipes[swipe_id]` (~1% of swiped msgs: in-place edits after generation), so `content`
  is `mes`, not a re-derived swipe. Single-generation messages (`swipes.length ≤ 1`) get no
  variant rows and `activeVariantIdx = null`. Per-swipe model/timing come from `swipe_info[i]`
  and are nullable (real data has `swipe_info` shorter than `swipes`). Imports are **not**
  forced to `raw` — we own the transcript, so an imported chat can be continued in sdk-mode
  (seed `session_entries` from `messages`); mode is a per-chat choice, not an import constraint.

### Conversation start — assistant-first vs user-first (validated)

A chat whose first message is `is_user:false` **starts assistant-first** — that
first message is the character's greeting (`character_versions.greetings[0]` after the
0009 fold; alternates are the rest of the array). Greeting *seeding* is still deferred
(Phase 5): seed `greetings[0]` as `messages` row #1 (`role:'assistant'`) with the
alternates as its `message_variants` (reuse the swipe machinery); empty `greetings` →
no opening (user speaks first, or a "generate to open" no-user-message turn).

- **New chat:** store the greeting as `messages` row #1 (`role:'assistant'`). For turn 1
  the model continues in-character from it (validated); subsequent turns resume the session.
- **Imported chat (full history):** seed the real transcript via the session store
  (`importSessionToStore` + the `parentUuid`-chained frame format — measured in
  `chat-session-store.test.ts` / `pnpm sdk:compaction`; resume needs a VALID-UUID session id).
  **Imports are NOT forced to `mode:'raw'`** (superseded — we own the transcript via the
  DB-backed store, so an imported chat can be continued in sdk-mode by seeding `session_entries`
  from its `messages`; mode is a per-chat choice).

## SDK session persistence — in our DB, not on disk (validated)

The Agent SDK persists a chat's transcript so it can `resume`. By default that's a
JSONL file under `~/.claude/projects/`. But `query({ options: { sessionStore } })`
takes a **custom `SessionStore`**, and — verified live — its `load()` is the
resume source (the SDK materializes a throwaway temp file from it). So **our
libSQL is the canonical session store; the disk file is transient SDK scratch we
never touch.** A `DbSessionStore implements SessionStore` needs a table:

```typescript
// The SDK's transcript frames (opaque: 'user' | 'assistant' | 'ai-title' |
// 'queue-operation' | 'last-prompt' | …). This is the SDK's resume substrate —
// SEPARATE from `messages` (our clean, user-facing canon mirrored from the
// stream for display/search/analytics).
export const sessionEntries = sqliteTable('session_entries', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),         // our chat
  sessionId: text('session_id').notNull(),   // SDK session id (== chats.session_id)
  subpath: text('subpath'),                  // SessionKey.subpath (subagents); null = main transcript
  seq: integer('seq').notNull(),             // append order
  uuid: text('uuid'),                        // SDK entry uuid — idempotency key (nullable: titles/tags have none)
  type: text('type').notNull(),
  entry: text('entry', { mode: 'json' }).notNull(), // the raw frame, stored opaquely
  createdAt: integer('created_at').notNull(),
});
// Unique index on (session_id, subpath, uuid) WHERE uuid IS NOT NULL — backs
// append()'s upsert/dedup (the SDK replays uuids on retry / importSessionToStore).
```

- **`append(key, entries)`** → upsert each entry by `uuid` (insert frames without a uuid).
- **`load(key)`** → select all rows for `(session_id, subpath)` ordered by `seq`, return the `entry` JSONs (or `null` if none). The SDK never byte-compares — JSON round-trip is fine.
- `listSessions` / `listSessionSummaries` are optional (we list from `chats`); stub or use `foldSessionSummary`.
- This also unlocks the **fork-and-convert escape valve** and **ST imports** (seed `session_entries`, then `resume`) without ever touching `~/.claude/projects`.

## Open question (Phase 3, not now)

Embedding model: **BGE-M3** (default, 1024-dim) vs **Qwen3-Embedding-4B** (SOTA).
The `embeddings.model` column + the vec table dimension are the only things that
change if we switch — decide when wiring Phase 3.
