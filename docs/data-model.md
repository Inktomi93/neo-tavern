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
  firstMessage: text('first_message'),
  exampleMessages: text('example_messages'),
  systemPrompt: text('system_prompt'),
  postHistoryInstructions: text('post_history_instructions'),
  alternateGreetings: text('alt_greetings', { mode: 'json' }),
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
  characterVersionId: text('character_version_id').notNull(),
  personaId: text('persona_id'),
  presetId: text('preset_id'),
  // YGWYG mode
  mode: text('mode', { enum: ['sdk', 'raw'] }).notNull().default('sdk'),
  provider: text('provider').notNull(), // 'anthropic-sdk' | 'anthropic-direct' | 'openrouter'
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
  costUsd: real('cost_usd'), // result.modelUsage[].costUSD — for the analytics layer
  presetId: text('preset_id'),
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

export const presets = sqliteTable('presets', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  schemaVersion: integer('schema_version').notNull().default(1), // config-blob upgrade path
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

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
  // ⚠️ DEFERRED TO PHASE 3 (NOT in the Phase-2 schema). The native-vector column +
  // index are added by a Phase-3 migration when RAG lands — verified end-to-end then.
  // SPIKE-VALIDATED approach (libSQL NATIVE vectors, no sqlite-vec): declare the column
  // via a Drizzle `customType` emitting `F32_BLOB(1024)`, `toDriver` via `vector32(...)`
  // (watch drizzle insert-API caveat #3899), `fromDriver` via Float32Array; then:
  //   embedding F32_BLOB(1024)
  //   CREATE INDEX embeddings_ann ON embeddings (libsql_vector_idx(embedding));
  // Query with vector_distance_cos(...) / vector_top_k('embeddings_ann', ...).
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
- **World Info is explicit attachment, not keyword scanning.** `chat_world_entries`
  and `cv_world_entries` are the junctions that attach entries to a chat or a
  character version. `world_entries.legacyKeys` preserves ST's keyword triggers for
  **import compatibility only** — we never scan on them.
- **`messages` is the source of truth; `session_entries` is an sdk-mode resume cache.**
  `messages` is the clean canon for **all** modes (display, search, analytics); the
  raw SDK transcript in `session_entries` exists only in sdk-mode, only to feed
  `resume`, and is regenerable-ish from `messages` (so if they ever diverge, `messages`
  wins). `seq` — not `createdAt` — is the canonical order. **Swipes/variants = a `message_variants`
  child table** (decided against `parentId`-siblings): real ST data shows swipes as N
  alternates at one slot — `swipes[]` + a parallel `swipe_info[]` where *each swipe can
  carry its own model* — so the faithful shape is `message_variants(message_id, idx,
  content, model, tokens_in/out, gen_started/finished)` + `messages.activeVariantIdx`
  (built Phase 5 with raw mode; sdk-mode never makes variants). `parentId` is reserved
  for future in-chat branching. See `docs/corpus-import.md` for the ST→variant mapping.
  Because sdk-mode is **stateless** (a fresh `query({resume})` per message),
  `result.usage` is per-turn, so `tokensIn/Out` + `cacheRead/WriteTokens` + `costUsd`
  are a direct copy — no cumulative differencing (a warm session would need it). These
  feed the analytics layer (the actual product).
- **Concurrency & live sync (multi-device, same chat — expected for one user on phone +
  desktop).** Writes are **optimistically concurrent on `seq`**: a send carries the
  client's last-seen tip (`expectedSeq`); if `MAX(seq) > expectedSeq` the router returns
  **409 + the missing messages and does NOT run generation** — so a stale device can
  never inject an incoherent turn. Resolution is non-destructive: **reconcile** (append
  at the real tip) or **fork** (`parentChatId` branch from `expectedSeq`). A **per-chat
  turn lock** (`chats.generatingSince` + timeout, or an in-process per-chat mutex for
  single-instance) allows **one in-flight generation per chat** — required so two
  concurrent `resume`s can't corrupt `session_entries`. Append-only + libSQL
  single-writer means a stale write can never *lose* the other device's turns; only
  ordering/coherence is at stake, which `seq` guards. **Live push** = a tRPC v11
  subscription (SSE transport) → TanStack Query invalidation, so the other device stays
  fresh without a refresh; the stateless/no-session design *enables* this (no session
  affinity to coordinate — the exact thing that was painful in st-bridge). SSE
  deployment: disable proxy buffering on the stream route (caddy auto-flushes
  `text/event-stream`) and emit `: ping` keep-alives (~20s) so h2/h3 idle timeouts don't
  drop an idle stream.
- **Chat mode / provider / session / fork.** `mode` = `sdk` | `raw`; `provider` =
  `anthropic-sdk` | `anthropic-direct` | `openrouter`; `sessionId` = the Agent SDK
  session (null after conversion to raw, or for imports); `parentChatId` +
  `forkedAt` + `convertedAt` track the one-way escape valve. Aggregates exist for
  fast analytics without scanning all messages.
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
  blobs read *structurally* that *evolve* — `user_settings.config`, `presets.config`
  (load → if `schemaVersion < current`, migrate → Zod-validate → write back); this
  replaces ST's scattered `if (x === undefined)` duck-typing;
  (3) **domain/content → `character_versions.version`** (canon history — a different
  concept). Opaque/archival blobs (`character_versions.raw`, `messages.rawRequest/
  rawResponse`, `chats.metadata`) are write-once — **not versioned.** Discriminator:
  *do I parse this on read AND will its shape change?* yes → version; column →
  migrations cover it; archival → leave it.

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
| `first_mes` | `firstMessage` (the greeting — see below) |
| `mes_example` | `exampleMessages` |
| `system_prompt` | `systemPrompt` |
| `post_history_instructions` | `postHistoryInstructions` |
| `alternate_greetings` | `alternateGreetings` |
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
- **`swipes` / `swipe_id`** = alternate generations. Import the active swipe
  (`swipes[swipe_id]`) as the canonical message; stash the rest in `raw` (imported
  chats are `mode:'raw'`, so swipes are legitimate there).

### Conversation start — assistant-first vs user-first (validated)

A chat whose first message is `is_user:false` **starts assistant-first** — that
first message is the character's greeting (== card `first_mes`).

- **New chat:** store the greeting as `messages` row #1 (`role:'assistant'`). The
  SDK prompt is user-only, so for turn 1 the greeting rides in the composed
  `systemPrompt` as the established opening line — **validated**: the model
  continues in-character from it. Subsequent turns use the SDK session (`resume`).
- **Imported chat (full history):** too much for the system prompt — seed the real
  transcript via the session store (`importSessionToStore` + the `parentUuid`-chained
  JSONL frame format; that's the Phase 4 task) and `resume`. Imported chats are
  `mode:'raw'` from day zero (the SDK can't continue them anyway).

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
