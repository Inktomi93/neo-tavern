# Parity audit — SillyTavern vs neo-tavern (backend + shared layer)

Goal: walk **every** SillyTavern module one-by-one, verify our coverage **live** (read the code,
don't trust a badge), and record the gap + how to close it. Scope of this pass = **backend +
`src/shared`** (the client is a later doc). We are trying to get the shared layer and backend
*fully set* before the frontend lands.

## How to use this doc (and why it's split this way)

We learned the hard way that a hardcoded verdict rots: the api-map's `scope.verdict` (`✅ HAVE`
etc.) is a **hand-typed dict in `tools/api-map/map_api.py`** — it does NOT inspect our code and
*will* go stale. The *inventory* (ST routes, our tRPC procs, hook counts) IS computed live by
tree-sitter each `pnpm api:map` run. So this doc divides labor accordingly:

- **Inventory = always from the tool, never copied here** (numbers copied into a doc are the exact
  thing that goes stale). For any row, regenerate with:
  - `pnpm api:q domain <name>` — ST routes + our procs/Hono routes for a domain
  - `pnpm api:q route <substr>` / `pnpm api:q proc <substr>` — raw route/proc lookup
  - `pnpm api:q hooks <subsystem>` — where a cross-cutting subsystem wires in
  - `pnpm api:q find <symbol>` — every call/import site of a symbol
- **Verdict + gap + close-the-gap = manual, lives here.** That's the human judgment the tool can't
  do. A row is only "done" when someone has *read both sides' code* and filled the gap analysis.

### Per-module audit protocol (do this for each 🔲 row)
1. `pnpm api:q domain <name>` → see ST's routes and our procs side by side.
2. Open ST's endpoint file(s) under `references/sillytavern/src/endpoints/` and our domain under
   `src/server/domain/<x>/` + router under `src/server/trpc/routers/<x>.ts`.
3. Compare **fields/shape** (not just route names) — the import parser (`domain/import/card.ts`)
   often preserves more than the editable surface exposes; note that.
4. Classify each ST capability as: **✅ covered** · **⚠️ partial / divergent-by-design** ·
   **❌ real gap**. Out-of-scope ST features get one line, not analysis.
5. Write the close-the-gap action (or "none — by design").
6. Flip the status, link the commit if you close anything.

### Status legend
✅ done (audited live) · 🔲 pending · ⏳ in progress · 🚫 out of scope (no audit, just a reason)

---

## Master module list (the definitive spine)

Every ST backend module (`references/sillytavern/src/endpoints/*.js` + `backends/`), mapped to our
domain and scope. This is the checklist; detailed sections follow for in-scope rows.

| ST endpoint file(s) | our domain | scope | audit |
|---|---|---|---|
| `characters.js`, `avatars.js` | characters | **IN** | ✅ done |
| `chats.js` | chat | **IN** | ✅ done |
| `worldinfo.js` | world-info | **IN** | ✅ done |
| `presets.js` | presets | **IN** | ✅ done |
| (none — client-only in ST) | personas | **IN** (neo first-classed it) | ✅ done |
| `openai.js`, `openrouter.js`, `anthropic.js`, `backends/` | providers | **IN** | ✅ done |
| `assets.js`, `files.js`, `thumbnails.js` | assets | **IN** | ✅ done |
| `secrets.js`, `users-admin.js`, `users-private.js`, `users-public.js` | auth | **IN** | ✅ done |
| `settings.js` | settings | **IN** | ✅ done |
| `tokenizers.js` | tokenizers | **IN** (internal, not an endpoint) | ✅ done |
| `vectors.js` | rag | **IN** (neo superset — corpus RAG) | ✅ done |
| `stats.js` | stats-analytics | **IN** (neo-evolved) | ⚠️ NOT BUILT |
| `image-metadata.js` | import (PNG tEXt) | **IN** (folded into import) | ✅ done |
| `groups.js` | groups | 🚫 OUT (for now) | 🚫 deferred per owner 2026-05-29 — revisit later |
| `themes.js`, `backgrounds.js`, `moving-ui.js` | ui-cosmetic | 🚫 OUT (for now) | 🚫 deferred per owner 2026-05-29 — single dark theme stands |
| `azure.js`, `google.js`, `novelai.js`, `horde.js`, `minimax.js`, `nanogpt.js`, `volcengine.js` | providers-other | 🚫 OUT | 🚫 ~21 other providers, skipped per scope |
| `stable-diffusion.js`, `images.js`, `caption.js`, `classify.js`, `sprites.js` | image-gen | 🚫 OUT | 🚫 slop guard (no img-gen/SD/caption/sprites) |
| `speech.js` | tts | 🚫 OUT | 🚫 slop guard (no TTS/STT) |
| `translate.js` | translate | 🚫 OUT | 🚫 slop guard |
| `search.js` | web-search | 🚫 OUT | 🚫 web/YouTube/SearXNG — not RP/corpus |
| `extensions.js` | extensions | 🚫 OUT | 🚫 no third-party extension system (single-user) |
| `quick-replies.js` | quick-replies | 🚫 OUT | 🚫 UI macro feature, not core |
| `content-manager.js` | content-mgr | 🚫 OUT | 🚫 default-content downloader |
| `backups.js`, `data-maid.js` | maintenance | 🚫 OUT | 🚫 SQLite handles backups differently |

> Cross-cutting *subsystems* (not REST domains) tracked separately by `pnpm api:q subsystems`:
> world-info, macro, persona, regex, prompt-assembly, prompt-manager, presets, vectors,
> chat-generate (IN, behavioral) · instruct, reasoning, slash-commands, tokenizers-zoo, themes,
> backgrounds, extensions, groups (OUT or WANT). Audit these *within* their owning domain section.

---

## Detailed audits

### characters — ✅ done (2026-05-29)
**ST surface** (`pnpm api:q domain characters`): 16 routes across `characters.js` (create, rename,
edit, edit-avatar, edit-attribute, merge-attributes, delete, all, get, chats, import, duplicate,
export) + `avatars.js` (get, upload, delete).
**Our surface**: `character.{list,get,create,update,remove}` (`trpc/routers/character.ts` →
`domain/character/service.ts`); avatars via `assets` (`GET /api/blob/:hash`, `POST
/api/assets/upload`); import/export via `import-export` (`POST /api/import/cards`, `GET
/api/export/character/:id`).

**Field parity** — strong. Two surfaces differ:
- *Editable* (`CreateCharacterInput`/`CharacterDetail`): name, description, personality, scenario,
  greetings[], exampleMessages, systemPrompt, postHistoryInstructions, tags[], creatorNotes,
  avatarAssetId (+ library meta handle/starred/archived). ST `first_mes` + `alternate_greetings`
  are **unified into one ordered `greetings[]`** ([0] = first message).
- *Import* (`domain/import/card.ts`) parses MORE and loses nothing: also reads `creator`,
  `character_version`, `character_book`, `extensions.regex_scripts`, and stores the whole
  normalized card verbatim in `character_versions.raw`.

**Gaps:**
- ❌ **`duplicate`** — no `character.duplicate` op (copy-on-write versioning is a different model;
  a client can read+create to fake it, but there's no one-call verb).
- ⚠️ **`characters/chats`** — `chat.list` returns *all* the user's chats with no `characterId`
  filter; per-character listing is client-side filtering, not a server endpoint.
- ⚠️ **`avatars/delete`** — no blob-delete route; by design (content-addressed blobs are GC'd, not
  user-deleted — deleting a shared blob could orphan refs).
- *Not surfaced as editable* (preserved in `raw` only): `creator`, `character_version` string.
- 🚫 out of scope: `extensions` (beyond regex), `talkativeness`, v3 `nickname` /
  `group_only_greetings` / `creator_notes_multilingual` (groups not built; `fav` ≈ `starred`).

**Close-the-gap:**
1. Add `character.duplicate(characterId)` — deep-copy active version into a new character row.
2. Add optional `characterId` filter to `chat.list` (or a `chat.listByCharacter`) to match
   `characters/chats` server-side.
3. Avatar delete: leave as-is (by-design GC). Document the decision; no action.
4. (Optional) expose `creator` / `character_version` read-only in `CharacterDetail` so the editor
   can show provenance without it being editable.

### tokenizers — ✅ done (2026-05-29)
**ST surface**: a per-model tokenizer *zoo* (`tokenizers.js` + `claude.json`/tiktoken/sentencepiece)
behind `getTokenCount(Async)`, `countTokensOpenAI(Async)`, `guesstimate`, encode/decode, and
selection/naming helpers.
**Our surface**: ONE generic counter — `estimateTokens` / `estimateTokensBatch`
(`src/shared/tokens.ts`, QuadChars). Wired into prompt-size via `buildPromptTrace`
(`staticTokens`/`dynamicTokens`, replacing the old raw char counts).
**Verdict**: the only ST tokenizer *feature* worth an analog is **counting**, and it's covered for
strings + message lists. Encode/decode (token IDs) stay OUT (need a real vocab; only feed
logit-bias/logprobs, which we don't build). Selection/naming/caching are moot for a single cheap
generic counter. Truth for billing = provider `usage` (captured post-turn). Real subword precision
seam stays open via `@anush008/tokenizers`.
**Gaps**: none in scope. (Per-section prompt counts, vs the static/dynamic halves we count today, is
a nice-to-have when the prompt-manager UI exists.)

### chat — ✅ done (2026-05-29)
**ST surface** (`pnpm api:q domain chat`): 13 routes in `chats.js` — 8 non-group (save, get, rename,
delete, export, import, search, recent) + 5 group (`group/import|get|info|delete|save`). Note: ST's
turn *generation* is NOT here — it lives in `backends/*` (audited under **providers**); swipe/edit/
branch are CLIENT-side over the JSONL array in ST, not server routes.
**Our surface**: 17 procs (`trpc/routers/chat.ts` → `domain/chat/*`). We own the transcript in the
DB (append-only `messages`, `seq`-ordered), so RP actions are server-side, not client array edits.

**Mapping** — we are a **superset** on RP actions:
| ST route | neo | verdict |
|---|---|---|
| chats/get | `chat.get` + `chat.messages` | ✅ |
| chats/rename | `chat.updateTitle` | ✅ |
| chats/delete | `chat.delete` | ✅ |
| chats/export | `GET /api/export/chat/:id` (import-export) | ✅ |
| chats/import | `POST /api/import/chats` (import-export) | ✅ |
| chats/recent | `chat.list` (`updatedAt desc`; pinned = `chat.star`; `max` = client slice) | ✅ |
| chats/save | — | ✅ by-design: **no "save"** — append-only DB-is-truth, every verb persists |
| chats/search | `search.segments` / `search.digests` (semantic) | ⚠️ divergent — semantic kNN over chat memory is a *superset* for "find chats about X"; no literal-substring filter |
| chats/group/* (5) | — | 🚫 OUT — groups deferred |

**NEO-only (12 procs ST has no server analog for):** `start` (lazy creation — ST creates eagerly),
`send` (the turn pipeline), `streamMessages` (SSE token stream — ST streams client-side),
`setProvider` (in-place provider switch — ST switching is global settings), `fork` (branch),
`swipe`, `selectVariant`, `editMessage` (ST does these client-side over JSONL), `compact`
(server compaction — ST has none), `previewAssembly` (prompt dry-run), `star`, `archive`.

**Gaps:** none must-have. ⚠️ only `chats/search` literal-substring isn't a dedicated path (semantic
search covers the use case, arguably better). Group chat is the sole uncovered ST chat surface and
is deliberately deferred.
**Verdict:** `✅ HAVE` is **accurate here** (no footnotes, unlike characters) — superset on RP.
**Close-the-gap:**
1. (optional, low priority) add a literal-substring chat filter if "find exact phrase across chats"
   is ever wanted; semantic search covers the common case today.
2. The **send/turn pipeline depth** (the 4 provider modes, cache_control, streaming) is audited
   under **providers** — cross-reference, don't duplicate here. Subsystem: `chat-generate`.

### world-info — ✅ done (2026-05-29) — simpler scope LOCKED by owner
**ST surface**: 5 routes (`worldinfo.js`) — list, get, delete, import, edit (whole-book ops) + the
advanced activation engine (recursion, secondary AND/NOT keys, timed effects, probability, floating
depth).
**Our surface**: 10 procs — `worldInfo.{listBooks,getBook,createBook,updateBook,removeBook}` +
`worldInfo.{listEntries,getEntry,createEntry,updateEntry,removeEntry}`. Separate book + entry CRUD
(ST edits whole books).
**Activation** (`prompt-assemble.ts:125` `renderWorldInfo`), verified: `always`→static (cached)
half, `keyword`→dynamic half; match = **any key whole-word present (`\b`, case-insensitive) in
recent messages**; pool = **attached entries only**; priority-sorted; `matchedKeys` traced.
**Mapping:**
- worldinfo/list,get → `listBooks`/`getBook` + `listEntries`/`getEntry` ✅ (superset granularity)
- worldinfo/edit → `updateBook`/`updateEntry` ✅ · delete → `removeBook`/`removeEntry` ✅
- worldinfo/import → `character_book` on card import + `createBook`/`createEntry` ✅
- 🚫 recursion / secondary keys / timed / probability / floating depth → **intentionally OUT**
  (owner-locked 2026-05-29; this is the deliberate simpler model, NOT a gap).
**Verdict:** `✅ HAVE` accurate within the locked scope — superset on CRUD granularity, the basic
always+keyword activation is correct and complete. Subsystems `world-info` + `prompt-assembly`.
**Gaps:** none (the ST advanced engine is a deliberate non-goal).

### import (PNG metadata) — ✅ done (2026-05-29)
**ST surface**: `image-metadata.js` (PNG tEXt read/write, mostly for SD images). Card import/export
in ST runs through `characters.js` import/export with the same `ccv3`/`chara` tEXt convention.
**Our surface**: full **round-trip**, hand-rolled (no PNG lib, mirroring ST):
- READ — `domain/import/card.ts` `readPngTextChunk` reads `ccv3` then `chara` base64 tEXt chunks
  (ported from card-curator `extract.py`).
- WRITE — `domain/export/png.ts` embeds the card JSON as a base64 `ccv3` tEXt chunk with correct
  CRC-32, stripping any stale chara/ccv3 chunk first.
**Mapping:** PNG card read ✅ · PNG card write ✅ · CRC-correct ✅ → **byte-compatible round-trip
with ST**. SD-image metadata (the rest of `image-metadata.js`) → 🚫 OUT (image-gen).
**Verdict:** `✅ HAVE` accurate — we read AND write ST-compatible character-card PNGs.
**Gaps:** none in scope.

### presets — ✅ done (2026-05-29)
**ST surface**: 3 routes (`presets.js`) — save, delete, restore. ST "preset" is a saved file; there
are MANY kinds (kobold/textgen/novel/openai generation-settings presets + the CC prompt-manager
config), one big bundle per provider.
**Our surface**: 5 CRUD procs (`preset.{list,get,create,update,remove}`). A preset = `{name, kind,
config: promptConfigSchema}` — the **PromptConfig blob** (reorderable sections + cache boundary +
generation `params` + `regexScripts`), with **copy-on-write versioning** (editing a pinned config
forks a new version; `preset_in_use` blocks deleting a version a chat/message pins).

**Mapping:**
- `presets/save` → `create` / `update` ✅
- `presets/delete` → `remove` ✅ (+ pinned-by-chat protection ST lacks)
- `presets/restore` → ⚠️ no explicit "restore built-in default" op; we have schema defaults
  (`DEFAULT_PROMPT_CONFIG`) so a client can create-from-default. Minor.
- ST's per-provider preset zoo (kobold/textgen/novel settings) → 🚫 OUT (providers-other); we model
  one unified Claude/CC prompt+params preset (the `kind` tag is the seam if more are ever needed).

**Verdict:** `✅ HAVE` accurate — **superset** (versioning + pin-protection; unifies ST's prompt +
generation presets into one typed blob). Subsystems `presets` + `prompt-manager` are this domain.
**Close-the-gap:** (optional) a `preset.resetToDefault` convenience mirroring `presets/restore`.

### personas — ✅ done (2026-05-29) — NEO win
**ST surface**: **zero endpoints**. Personas live client-side in ST (`public/scripts/personas.js`,
stored in user settings + the avatars dir) — no server model.
**Our surface**: a first-class 5-op router (`persona.{list,get,create,update,remove}`), owner-scoped,
fields `{name, description, avatarAssetId, metadata}`.
**Mapping:** ST persona = name + description (the persona prompt) + avatar + an inject depth/position.
We cover name/description/avatar; **placement is handled by the prompt-config persona section**
(`assemblePrompt`), not a per-persona depth field — consistent with our explicit-prompt-structure
model. `metadata` blob is the seam for anything extra.
**Verdict:** `✅ HAVE` accurate — a clean **NEO win** (first-class entity + router where ST has none).
**Gaps:** none. Per-persona inject depth is by-design owned by the prompt config, not the persona row.

### providers — ✅ done (2026-05-29)
**ST surface** (`pnpm api:q domain providers`): 27 routes across `openai.js` / `anthropic.js` /
`openrouter.js` / `backends/chat-completions.js`. Almost all are OUT capabilities — caption-image,
generate-voice, transcribe-audio, generate-image/video, image/generate (image-gen + TTS/STT, slop
guard); embedding-model lists for chutes/nanogpt/siliconflow/workers-ai (we embed in-process);
electronhub/chutes sub-providers (providers-other). The **in-scope** core is just:
- `backends/chat-completions/generate` — **the turn** (+ `/process` prompt processing)
- `backends/chat-completions/status` — connection/auth test
- `openrouter/credits` + `openrouter/models/*` — account + catalog.

**Our surface**: 7 meta procs (`models`, `rawModels`, `orCredits`, `orActivity`, `orProviders`,
`orEndpoints`, `orGenerationCost`) for catalog/account; the **turn itself** is `chat.send` →
`resolveTurnRouting` (`domain/chat/routing.ts`) → the runners under `src/server/providers/`.

**The 4-mode matrix — all implemented, tested, and matching the locked decisions:**
| # | api × source | runner | verified |
|---|---|---|---|
| 1 | agent-sdk × max-pro-sub | agent-sdk (`buildClaudeSdkEnv`) | ✅ routing + `claude-sdk.ts` + `routing.test.ts` |
| 2 | agent-sdk × openrouter | agent-sdk (`buildClaudeOpenRouterEnv`) | ✅ **firewall confirmed** (`env.ts:304`): isolated config dir, nulled OAuth/identity tokens, OR Anthropic-skin base URL + tier→OR-id map; sub credential cannot leak |
| 3 | chat-completions × openrouter | openrouter (`@openrouter/sdk` `chat.send`) | ✅ `openrouter/chat-completions.ts` + **caching confirmed** (`caching.ts`): Anthropic-only `ephemeral` + `{order:["Anthropic"]}` pin, caller routing wins |
| 4 | responses × openrouter | openrouter (`beta.responses`) | ✅ `openrouter/responses.ts` + `providerRouting` from `chats.metadata` |

`resolveTurnRouting` is the **single** owner of selection (consumed by send/swipe/compaction/
lifecycle/preview — never a hardcoded runner), throws loud on incoherent combos.

**Mapping:**
- `backends/chat-completions/generate` → `chat.send` + the 4 runners ✅ (we're *richer*: ST has one
  CC backend behind a source switch; we split agent-sdk Claude-native (free sub + cached paid skin)
  from the OR catalog).
- `openrouter/credits` → `orCredits`; `openrouter/models/*` → `models`/`rawModels`/`orProviders`/
  `orEndpoints` ✅ — **superset** (we also expose `orActivity`, `orGenerationCost`).
- `backends/chat-completions/bias` → 🚫 OUT (logit-bias; we build no logit/logprobs features).
- voice/image/video/caption/transcribe/embedding-lists → 🚫 OUT (slop guard / in-process embeds).

**Gaps:**
- ⚠️ **`backends/chat-completions/status`** — ST has a connection/auth test route; we have no
  dedicated "test this key / is the sub authed" proc (the credential resolver gates at turn time
  instead). Minor — a future key-entry UI would want it.

**Verdict:** `✅ HAVE` **accurate**. The 4 modes are fully built, tested, and faithful to the
caching + credential-firewall decisions. Superset on OR account introspection; ST's other 20 routes
are deliberately OUT.
**Close-the-gap:** (minor, low priority) add a `provider.testConnection` / `status` proc so a
settings UI can validate an OpenRouter key and the Max-sub auth before a turn. Subsystem:
`chat-generate` (the turn pipeline audited here, not under chat).

### auth — ✅ done (2026-05-29) — strong NEO win
**ST surface**: 25 routes — `users-private.js` (9: logout, me, change-avatar, change-password,
backup, reset-settings, change-name, reset-step1/2), `users-admin.js` (8: get, disable, enable,
promote, demote, create, delete, slugify), `secrets.js` (8: write, read, view, find, delete,
rotate, rename, settings). ST **is its own IdP** (local passwords) and stores secrets **PLAINTEXT**.
**Our surface**: 13 — `credentials.{hasMyOpenRouterKey,setMyOpenRouterKey,clearMyOpenRouterKey}`,
`userAdmin.{listUsers,setRole,setEnabled,listSessions,revokeSession,revokeUserSessions}`, OIDC
routes (`/api/auth/{login,callback,logout,me}`).

**Mapping:**
- logout → `/api/auth/logout` ✅ · me → `/api/auth/me` ✅
- disable/enable → `userAdmin.setEnabled` ✅ · promote/demote → `userAdmin.setRole` ✅ · users/get →
  `userAdmin.listUsers` ✅
- secrets/write → `setMyOpenRouterKey` (per-user **AES-256-GCM**) ✅ · secrets/delete →
  `clearMyOpenRouterKey` ✅ · secrets/rotate → re-set overwrites ✅
- **NEO-only (ST lacks):** revocable server-side sessions + admin cross-user revoke
  (`listSessions`/`revokeSession`/`revokeUserSessions`) — the BFF model.

**By-design divergences (NOT gaps — this is the locked auth philosophy):**
- 🚫 change-password, reset-step1/2 → we are **NEVER an IdP**; identity is external (OIDC /
  forward-header / single-user). No passwords to change or reset.
- 🚫 users/create → we **provision-on-first-SSO** (`provisionIdentity`), not manual create.
- 🚫 change-name → handle = IdP `preferred_username`, not user-editable.
- 🚫 secrets/read + secrets/view → we **never read a key back** (existence check only via
  `hasMyOpenRouterKey`); ST's `view` exposes plaintext secrets. Deliberate.
- 🚫 change-avatar (no user avatars), backup (maintenance), slugify/find/rename (utility/multi-key).

**Gaps:** ⚠️ `users/delete` — we `setEnabled(false)` (disable) but have no hard-delete user op
(arguably safer; flag only if true deletion is wanted). Otherwise none.
**Verdict:** `✅ HAVE` understates it — **major security win**: encrypted-at-rest per-user creds
(vs ST plaintext), no-IdP external identity, revocable BFF sessions, write-only key handling.

### assets — ✅ done (2026-05-29)
**ST surface**: 8 routes — `assets.js` (get, download, delete, character), `files.js`
(sanitize-filename, upload, delete, verify). ST splits storage into avatars/thumbnails/backgrounds/
sprites with filename handling.
**Our surface**: 2 — `GET /api/blob/:hash`, `POST /api/assets/upload`. **One content-addressed blob
store**: the sha-256 hash IS the name AND the integrity guarantee.
**Mapping:**
- files/upload + assets/get/character → `POST /api/assets/upload` ✅
- assets/get/download → `GET /api/blob/:hash` ✅
- files/sanitize-filename → 🚫 N/A — no filenames (hash-addressed) → nothing to sanitize.
- files/verify → ✅ by-construction — fetch-by-hash is verification (content can't mismatch its hash).
- assets/delete + files/delete → ⚠️ no delete (content-addressed GC, by design — a shared blob
  could be referenced by many rows; same call as the characters `avatars/delete` note).
- avatars/thumbnails/backgrounds/sprites split → one store; **thumbnails (resize)** not generated.
**Gaps:** ⚠️ no thumbnail generation — we serve the raw blob; could matter for a 300-avatar grid
(perf). ⚠️ no delete (by-design GC). Otherwise the content-addressed model is a clean simplification.
**Verdict:** `✅ HAVE` accurate — hash-addressing collapses ST's filename/sanitize/verify machinery.
**Close-the-gap:** (optional) on-the-fly avatar thumbnail endpoint if the library grid needs it.

### settings — ✅ done (2026-05-29)
**ST surface**: 6 routes (`settings.js`) — save, get + 4 snapshot ops (get-snapshots,
make-snapshot, load-snapshot, restore-snapshot). ST settings = one big monolithic blob; snapshots
back up / restore that blob.
**Our surface**: 6 procs across the **three typed tiers** — `getUserSettings`/`updateUserSettings`
(per-user), `getAppSettings`/`updateAppSettings` (admin runtime toggles), `getGlobalSetting`/
`setGlobalSetting` (the KV underneath). Matches the locked "three typed config tiers" (env.ts floor
→ AppSettings DB override → UserSettings).
**Mapping:**
- settings/save → `update{User,App}Settings` / `setGlobalSetting` ✅
- settings/get → `get{User,App}Settings` / `getGlobalSetting` ✅
- snapshot ops (4) → 🚫 by-design OUT — typed tiers are a few structured knobs, not a sprawling blob
  that needs versioned backup/restore (that's a maintenance concern over ST's monolith).
**Verdict:** `✅ HAVE` accurate — typed tiers are a **structural win** over ST's one-blob settings.
**Gaps:** none in scope.

### rag (vectors) — ✅ done (2026-05-29) — NEO superset
**ST surface**: 7 routes (`vectors.js`) — query, query-multi, insert, list, delete, purge, purge-all.
ST "vectors" = **per-chat RAG memory** with manual vector CRUD.
**Our surface**: 8 — `search.{knn,find,discover,digests,segments,corpus,images}` + `corpus.embed`.
Corpus-wide semantic search (BGE-M3 + reranker) **derived from canon**, plus per-chat memory via
`chat_segments`/`chat_digests` (`domain/chat/memory.ts`).
**Mapping:**
- vector/query, query-multi → `search.knn`/`find` ✅ (+ rerank, `discover`, multi-modal `images`)
- vector/insert → `corpus.embed` (indexing) ✅
- ST's per-chat memory use case → covered by searchable `segments`/`digests` ✅
- vector/list, delete, purge, purge-all → 🚫 by-design divergence: embeddings are **derived from
  source-of-truth + re-indexed** (CLI `db:reindex`, `clearVectorTable`, boot self-heal via
  `assertVectorIndexes`), not manually CRUD'd per-vector. No per-vector procs by design.
**Verdict:** `🟣 NEO-ONLY` accurate — we cover ST's per-chat use case AND add the corpus superpower
(the search *engine* is built + validated). Superset.
**Gaps:** none for the search engine. (The *analytics* layer on top is tracked under
stats-analytics, below — and it's the real unbuilt piece.)

### stats-analytics — ⚠️ NOT BUILT (badge overstates — real in-scope gap)
**ST surface**: 3 routes (`stats.js`) — get, recreate, update. Per-chat message stats (counts,
word totals, timing).
**Our surface**: **neo = 0 procs.** `hubness.ts` exists as an internal corpus primitive but is
exposed by **no tRPC proc**; the headline analytics (keyword co-occurrence, theme analysis,
duplicate detection) is `docs/breadth-buildout.md` **Track B** — "plumbing-not-product," **planned,
not built**.
**Honest read:** the `🟣 NEO-ONLY` badge implies a win, but reality is neither ST's basic per-chat
stats NOR our differentiator analytics are exposed. This is the **largest unbuilt in-scope backend
piece** and the stated *killer differentiator*.
**Close-the-gap:**
1. Build **Track B** (co-occurrence on `chat_digests.keywords`, theme route, dedup) — the rebuild
   map in `breadth-buildout.md` ports card-curator/st-bridge `file:line`.
2. Expose `hubness` + the analytics via a `corpus`/`analytics` router.
3. Decide whether basic per-chat stats (ST `stats/get`) are worth a small proc or subsumed by the
   corpus layer. Subsystem: none (greenfield).

---

## Deferred (owner-decided OUT for now, 2026-05-29)

### groups — 🚫 out for now
ST `groups.js` (4 routes) — multi-character RP. Real ST capability we lack; **deferred**, not
killed. Revisit when the single-char chat surface is solid. No audit this pass.

### ui-cosmetic — 🚫 out for now
ST `themes.js` / `backgrounds.js` / `moving-ui.js`. **Deferred** — the single dark theme stands.
No audit this pass.
