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

export const personas = sqliteTable('personas', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  avatarAssetId: text('avatar_asset_id'),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at').notNull(),
});

export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  handle: text('handle').notNull().unique(),
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
  // Linear in YGWYG mode (no parent_id needed), set in raw mode if swipes used
  parentId: text('parent_id'),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),
  toolCalls: text('tool_calls', { mode: 'json' }),
  model: text('model'),
  provider: text('provider'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  presetId: text('preset_id'),
  rawRequest: text('raw_request', { mode: 'json' }),
  rawResponse: text('raw_response', { mode: 'json' }),
  createdAt: integer('created_at').notNull(),
  editedAt: integer('edited_at'),
});

export const worldBooks = sqliteTable('world_books', {
  id: text('id').primaryKey(),
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
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
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
  // SPIKE FINDING (docs/build-plan.md): use libSQL NATIVE vectors, not sqlite-vec.
  // The vector is a column on THIS table — drop the old `vecRowid` + the separate
  // `embeddings_vec` vec0 virtual table. Declared as F32_BLOB(1024) via a Drizzle
  // custom column type / raw DDL:
  //   embedding F32_BLOB(1024)
  //   CREATE INDEX embeddings_ann ON embeddings (libsql_vector_idx(embedding));
  // Query with vector_distance_cos(...) / vector_top_k('embeddings_ann', ...).
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at').notNull(),
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
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

- **Character versioning.** `characters` is the stable identity (handle, starred,
  archived); the actual content lives in immutable `character_versions`, with
  `currentVersionId` pointing at the active one. This is what lets the refinery
  (Score → Rewrite → Analyze) mint new versions while preserving history —
  `refineryScore` / `refineryAnalysis` ride on the version.
- **World Info is explicit attachment, not keyword scanning.** `chat_world_entries`
  and `cv_world_entries` are the junctions that attach entries to a chat or a
  character version. `world_entries.legacyKeys` preserves ST's keyword triggers for
  **import compatibility only** — we never scan on them.
- **Messages are append-only.** `parentId` stays null in `sdk`/YGWYG mode (linear);
  it's only set in `raw` mode if swipes are used. Full token accounting
  (`tokensIn/Out`, `cacheRead/WriteTokens`) + `rawRequest`/`rawResponse` feed the
  analytics layer (the actual product).
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
- **Assets are content-addressed.** `hash` is unique; binaries live on the mounted
  volume and are referenced by hash. The DB row is metadata only.
- **Tags are polymorphic** (`taggables` over any entity), `manual` or `auto` (the
  latter for theme-clustering output).
- `presets` (kind + JSON config) and `settings` (key/JSON value) are config blobs.

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

## Open question (Phase 3, not now)

Embedding model: **BGE-M3** (default, 1024-dim) vs **Qwen3-Embedding-4B** (SOTA).
The `embeddings.model` column + the vec table dimension are the only things that
change if we switch — decide when wiring Phase 3.
