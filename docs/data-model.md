# Data model — design notes (the *why*)

**The schema itself lives in `src/db/schema.ts`** (heavily commented — that's the source of
truth) and evolves via additive migrations in `src/db/migrations/`. This doc is NOT a parallel
schema listing (that just drifts); it's the **design rationale** behind the tables — the "why"
that the code can't fully carry. Conventions: `id` = text (nanoid); timestamps = integer (unix
epoch ms — always a **UTC** instant, parsed/normalized via `src/shared/time.ts` at every
provider/import boundary, rendered local on the client; see `docs/conventions.md` → "Time & dates");
JSON columns use Drizzle `{ mode: 'json' }`; enums = text + `enum` constraint.

## Character versioning (identity / content / instance)
`characters` is the stable identity (immutable `id`, rename-able `handle`, starred, archived);
content lives in immutable `character_versions` (`currentVersionId` points at the active one);
a `chat` pins ONE version via `chats.characterVersionId`. This is the answer to ST's "the PNG
filename *is* the character" — identity, content, and the instance that ran a version are three
separate things. It lets a future refinery (Score → Rewrite → Analyze) mint versions while
preserving history (`refineryScore`/`refineryAnalysis` ride on the version), and it makes cards
queryable for analytics.
- **Increment policy = copy-on-write.** A version becomes immutable the moment any chat pins
  it. Editing a version no chat references mutates it in place (drafts don't spam versions);
  editing a pinned version forks a new row (`version = max+1`) and repoints `currentVersionId`.
  So editing a character never rewrites past canon. (Reference implementation:
  `src/server/domain/import/service.ts`, mirrored for presets.)
- **Greetings** are ONE ordered array (`character_versions.greetings[]`, migration 0009): `[0]`
  = ST's `first_mes`, the rest = alternate greetings — the same swipeable opening set in ST.
  Seeding makes `greetings[0]` the opening message; alternates become `message_variants`.

## World Info — explicit attachment with a per-entry `scope`
`chat_world_entries` / `cv_world_entries` attach entries — the **candidate pool** (we never
scan unattached entries, unlike ST). `scope` decides activation AND placement:
- **`always`** (default) → the **static** (cached) system prompt — byte-stable, paid once.
- **`keyword`** → matched against recent messages by the entry's keys (basic, case-insensitive,
  whole-word; `world_entries.legacyKeys` is the imported seed), injected into the **dynamic**
  system prompt on a hit (so the per-turn set never busts the cached static prefix). `scope`
  *is* the placement — no separate `position` column.

Deliberately NOT ST (slop guard): no secondary-key AND/NOT, recursion, min-activations, timed
effects, probability, inclusion groups, or floating `atDepth`.

## `messages` is canon; `session_entries` is an agent-sdk resume cache
`messages` is the clean source of truth for **all** modes (display, search, analytics); the raw
SDK transcript in `session_entries` exists only for the agent-sdk runner, only to feed `resume`,
and is regenerable from `messages` (if they ever diverge, `messages` wins). `seq` — not
`createdAt` — is the canonical order and the fork/swipe anchor.
- **Swipes/variants = a `message_variants` child table** (not `parentId`-siblings): real ST data
  shows swipes as N alternates at one slot (`swipes[]` + a parallel `swipe_info[]` where each
  swipe can carry its own model), so the faithful shape is `message_variants(message_id, idx,
  content, model, …)` + `messages.activeVariantIdx`. The ST importer is the first writer
  (~42% of messages carry alternates); the openrouter/agent-sdk swipe path adds them live.
  `parentId` is reserved for future in-chat branching.
- Because the agent-sdk runner is **stateless** (a fresh `query({resume})` per message),
  `result.usage` is per-turn → `tokensIn/Out` + cache tokens + `costUsd` are a direct copy (no
  cumulative differencing). These feed analytics.
- **Per-turn provenance columns record what ACTUALLY ran**, normalized so cross-mode
  filtering/analytics stays honest. The "why did generation stop?" signal is **two columns**:
  `finish_reason` (migration 0013) is the *normalized* cross-mode vocab (`stop|length|filter|tool|
  other`, via `providers/turn.ts` `normalizeFinishReason` — the queryable one, e.g. a "truncated"
  UI badge), while `stop_reason` keeps the raw provider string (`stop_reason`/`finish_reason`) as
  provenance. `reasoning_effort` stores the resolved effort (analytics axis); `gen_started`/
  `gen_finished` (migration 0012, epoch-ms UTC) hold generation timing — populated by the ST
  importer from a message's top-level fields; live turns carry per-gen timing on `message_variants`.
  All nullable (null for imports / not-provided).
- `session_entries.subpath` stores **`""`** (not NULL) for the main transcript: the uuid-dedup
  unique index `(session_id, subpath, uuid) WHERE uuid IS NOT NULL` is defeated by a NULL
  `subpath` (SQLite treats every NULL as distinct), so `""` keeps idempotency honest. The store
  persists every frame the SDK emits and replays in `seq` order, so resume works across
  compaction (the boundary persists as a `system`/`compact_boundary` marker + a synthetic `user`
  summary frame — measured; see `docs/sdk-notes.md`).

## Provider routing — `api` × `source` × `model` (migration 0011)
A chat's NEXT-turn routing is three columns; `messages.*` records what ACTUALLY ran (provenance):
- `chats.api` ∈ `agent-sdk` | `chat-completions` | `responses` — the wire protocol / runner.
- `chats.source` ∈ `max-pro-sub` | `openrouter` — which credential backs it.
- `chats.model` — interpreted against the (api, source) catalog; null → the resolver default.

`domain/chat/routing.ts` `resolveTurnRouting(chat, config)` is the **single owner** of selection
— it switches on `(api, source)` to pick the runner + env, and branches `send`/`swipe` between
the agent-sdk runner (sessionStore + resume) and the openrouter runner (history rebuilt from
canon, no `session_entries`). Model *validity* is checked at SELECTION time (the picker), not on
the send hot path; a stale stored id just falls back. The four built pairings + their caching
trade-offs are the table in `CLAUDE.md` (RP philosophy → Provider modes). `setProvider` switches
in place; `forkChat` branches into a new chat (`parentChatId`/`forkedAt`); both are one-way the
canon survives. raw-mode provider-routing prefs ride in `chats.metadata` → the request `provider`
field (slop guard — promote to a column if earned).

## Compaction — durable events + a cross-mode summary artifact
Two additive pieces. **`chat_events`** (migration 0014) is a durable per-chat event log: the
`TurnEvent[]` a turn returns (compaction / api_retry / rate_limit / status / auth), persisted so the
record survives a restart (the in-memory log ring doesn't); metadata only, never RP content; surfaced in
`/api/_debug/db/chat`. **`chats.compactSummary` + `compactedAtSeq`** (migration 0015) make a compaction
*portable*: a `/compact` captures the SDK's summary text + the canon `seq` it covers, and the
`{{compact_summary}}` prompt marker renders it so the STATELESS openrouter runner can "pick up from the
compaction point" (history rebuilt from `seq > anchor`); the artifact crosses `forkChat`. **Canon
(`messages`) is never touched** — pre-compaction history stays fully viewable; only what's sent to the
model changes. (agent-sdk carries compaction natively in its session, so the marker stays null there.)

## Concurrency & live sync (multi-device, one user on phone + desktop)
- **✅ BUILT — optimistic `seq` guard + per-chat lock.** A send/swipe carries the client's
  last-seen tip (`expectedSeq`); if `MAX(seq) ≠ expectedSeq` the domain returns
  `status:"stale"` + the full current messages + `latestSeq` and does NOT generate — a stale
  device can't inject an incoherent turn. The per-chat turn lock (`_shared/lock.ts`
  `withChatLock`) is an in-process mutex: one in-flight generation per chat, so concurrent
  resumes can't corrupt `session_entries`.
- **✅ BUILT — atomic send.** A failed generation (typed `TurnError`) rolls the user message
  back out and returns `status:"error" + {code, retryable, resetsAt?}` (the provider-agnostic
  vocabulary both runners share), so the chat stays at its prior coherent tip.
- **✅ WORKS TODAY — refresh/reconnect converges.** Because the design is stateless and the DB
  is the single source of truth (no session affinity, no server-held chat state), the same chat
  open on a PC and a phone reconciles the moment either device reconnects or refreshes — it
  just re-fetches canon. This is the intended multi-device behavior, by design.
- **⏭ DEFERRED — *automatic* push (no manual refresh).** A tRPC SSE subscription → Query
  invalidation so the *other* device updates live without the user refreshing. The stateless
  design is precisely what enables this drop-in later (nothing to coordinate). Append-only +
  libSQL single-writer already means a stale write can never *lose* turns; only the
  "see it without refreshing" convenience is outstanding.

## Embeddings = libSQL native vectors
`embeddings` rows are polymorphic (`entityType`/`entityId`) and hold the vector directly in an
`F32_BLOB(1024)` column with a `libsql_vector_idx` ANN index — no sqlite-vec, no `vec0` table.
`1024` matches BGE-M3; the `model` column + the column dimension are the only things that change
on a model swap. `hubScore` (CSLS, migration 0005) + `sourceText` (for the reranker, 0006) ride
along. Search: `vector_top_k('embeddings_ann', vector32(?), k)` → exact cosine re-rank → CSLS
adjust → optional cross-encoder rerank. See `docs/corpus-import.md`. Entity types: `character` +
`chat_segment` (the corpus, batch-embedded). The retired `chat_message` memory (#40) is **replaced**
by the dedicated `chat_digests` table (below).

## Chat memory = `chat_digests` (its own table — migration 0018)

The within-chat `{{memory}}` system (`docs/memory.md`) stores per-N-turn **structured digests** in a
**dedicated `chat_digests` table** — NOT the polymorphic `embeddings` table — so it gets real FKs:
`chatId` → `chats.id` **cascade** (nuke-the-chat cleans up its digests), `ownerId` → `users.id`
(indexed — per-user corpus scoping), `characterVersionId` → `characterVersions.id` RESTRICT (the
chat's pin). Columns: `tier` (0 = per-block, 1+ = consolidation), `blockIdx`, `seqStart`/`seqEnd` (the
canon span — verbatim click-through **and** the edit-staleness key), `text`, `topicAnchor`,
`keywords` (JSON), `model`, `summarizerModel`, `embedding F32_BLOB(1024)` (always populated),
`hubScore`, `tokens`; unique `(chatId, tier, blockIdx)`; hand-added `chat_digests_ann` ANN index. Two
read paths over ONE substrate: within-chat memory injection (**exact in-process cosine, scoped by
`chatId`** — ignores the ANN) and cross-chat **corpus search** (the ANN — hybrid with `chat_segment`;
staged, see `docs/memory.md` §4). **Forward-correctness:** the polymorphic `embeddings` rows have no
`ownerId`, so per-user scoping of that legacy layer is a follow-up under real multi-user.

## Assets are content-addressed (CAS — migration 0016)
`hash` (sha-256, unique) IS the locator: binaries (card PNGs, persona avatars) live on the mounted
volume in a sharded CAS tree (`src/server/storage/cas.ts`, `<h0:2>/<h2:4>/<hash>`), the DB row is
metadata only. **No `path` column** (the hash → `cas.blobPath` resolves it; a re-rooted volume needs
no DB rewrite). Image **bytes never go in the DB.** **`assets` are global — NO `ownerId`** (dedup by
hash — identical art across users is one blob). **NO refcount column** (refcounts drift) — GC is
**mark-sweep** over the avatar refs (`character_versions`/`personas.avatarAssetId` → `assets.id` ON
DELETE SET NULL, the FKs 0007 skipped), with a grace window so it can't race an in-flight import.
A card blob's hash equals `characters.importHash` (same whole-file sha-256) → a built-in integrity
check on the forward-import + backfill paths. Image *analysis* (visual embeddings) is a batch job —
the derived vector lands in `image_embeddings` (a SEPARATE 1152-dim SigLIP space, NOT the 1024-dim
text `embeddings`), the bytes don't. Full design + the caddy serving contract: **`docs/assets.md`**.

## Multi-user: designed, single-user implemented
Every top-level *owned* entity carries `ownerId → users.id` (personas, characters, chats,
presets, world_books, tags); children inherit via their parent. Scoping is **enforced in the
`domain/*` layer** (every read/write bakes `WHERE owner_id = ctx.user.id`), exercised even with
one user, so a second user is a no-op not a rewrite. Global uniques become composite under
multi-user (`unique(ownerId, handle)` etc.). Identity = `X-Authentik-Username` at one auth seam:
trusted-proxy header → that user; else `DEFAULT_USER_HANDLE`. No session, no CSRF.

## Versioning — three kinds, don't conflate
1. **Table/column shape → Drizzle migrations** (the migration history *is* the version; no
   per-table version column).
2. **JSON-blob shape → an explicit `schemaVersion` + pure migrate-fns**, ONLY for blobs read
   *structurally* that *evolve*: `user_settings.config`, `preset_versions.config` (load → if
   `schemaVersion < current`, migrate → Zod-validate → write back). Replaces ST's scattered
   `if (x === undefined)` duck-typing.
3. **Domain/content → `character_versions.version` AND `preset_versions.version`** (canon
   history, copy-on-write). Presets are type-3 as of migration 0007 — a mutable preset would
   silently rewrite the recorded basis of every past message (`messages.presetVersionId`),
   breaking corpus analytics.

Opaque/archival blobs (`character_versions.raw`, `messages.rawRequest/rawResponse`,
`chats.metadata`) are write-once — **not versioned.** Discriminator: *do I parse this on read AND
will its shape change?* yes → version; column → migrations cover it; archival → leave it.

## Referential integrity — enforced FKs (migration 0007)
Internal links are real foreign keys with an explicit cascade policy (before 0007 only
`ownerId → users` existed). The shape:
- **CASCADE** down ownership/containment — a deleted chat takes its messages/variants/
  session_entries/junctions; a deleted character takes its versions; a deleted preset takes its
  versions; a deleted world_book takes its entries.
- **RESTRICT** on provenance pins — `chats.characterVersionId`, `chats`/`messages.presetVersionId`.
  Deleting a character/preset *with chats* fails atomically (CASCADE→version hits the RESTRICT),
  enforcing **archive-don't-delete**.
- **SET NULL** for circular `currentVersionId` pointers and optional/self refs
  (`chats.personaId`, `parentChatId`, `messages.parentId`).
- **Polymorphic refs cannot be FKs** and stay plain text: `embeddings.(entityType, entityId)`,
  `taggables.(entityType, entityId)`.

Verified on the real corpus: `PRAGMA foreign_key_check` returns zero rows after `pnpm import:st`.

## SDK session persistence — in our DB, not on disk (validated)
The Agent SDK persists a chat's transcript so it can `resume` (default: a JSONL under
`~/.claude/projects/`). `query({ options: { sessionStore } })` takes a custom `SessionStore`, and
its `load()` is the resume source — so **our libSQL is the canonical store; the disk file is
transient scratch we never touch.** `session_entries` holds the SDK's opaque transcript frames
(SEPARATE from `messages`):
- **`append(key, entries)`** → upsert each entry by `uuid` (insert frames without one).
- **`load(key)`** → select all rows for `(session_id, subpath)` ordered by `seq`, return the
  `entry` JSONs (or null). The SDK never byte-compares — JSON round-trip is fine.

This unlocks the fork/convert escape valve and ST-import continuation without ever touching
`~/.claude/projects`. Seeding a session from plain canon is empirically validated
(`domain/chat/seed.ts` `buildSeedFrames`; see `docs/sdk-notes.md`).

## Importing from SillyTavern (validated against real cards + chats)
Field maps + parser `file:line` references live in **`docs/corpus-import.md`** (the answer key).
Schema-side mapping summary:
- **Card PNG** → `character_versions`: `first_mes` + `alternate_greetings` → `greetings[]`
  (folded), `description`/`personality`/`scenario`/`mes_example`/`system_prompt`/
  `post_history_instructions`/`tags`/`creator_notes` → their columns; whole card JSON → `raw`,
  `importHash` = hash of the card.
- **Chat JSONL** → `messages` + `message_variants`: `is_user` → role; `mes` → `content` (the
  authoritative rendered text, even when it diverges from `swipes[swipe_id]`); `swipes[]` → one
  `message_variants` row each with `activeVariantIdx = swipe_id`; per-swipe model/timing from
  `swipe_info[i]` (nullable — real data has it shorter than `swipes`).
- **Assistant-first vs user-first:** a chat whose first message is `is_user:false` starts with
  the character's greeting. **Imports are NOT forced to any provider mode** — we own the
  transcript via the DB-backed store, so an imported chat can be continued in any mode by
  seeding `session_entries` from its `messages`. Mode is a per-chat choice, not an import
  constraint.
