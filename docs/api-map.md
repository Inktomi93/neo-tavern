# API & layer map — SillyTavern vs neo-tavern

> **Generated** by `tools/api-map/map_api.py` (tree-sitter AST). Regenerate: `pnpm api:map`. Snapshot: 2026-05-29.
>
> Heuristic surface map (not a type-checker): dynamically-registered / deeply-nested routes may be missed. The point is the **domain-level gap**, NOT route parity. **We are NOT chasing ST's route count** — the 🚫 OUT list is deliberate (CLAUDE.md slop guard).

## Summary

- **SillyTavern:** 263 REST routes across 45 endpoint files.
- **neo-tavern:** 81 tRPC procedures + 12 Hono routes.
- **Layers (files / LOC):** ST → server 95/33,208, client 202/132,645, **shared 0/0**.  neo → shared 26/1,760, server 162/18,246, client 3/13.

## Capability domains (scope-tagged)

| Domain | Scope | ST routes | neo surface | Note |
|---|---|--:|--:|---|
| **rag** | 🟣 NEO-ONLY | 7 | 8 | corpus semantic search + analytics — the killer differentiator. ST 'vector' is per-chat retrieval only; ST 'search' is web search. |
| **stats-analytics** | 🟣 NEO-ONLY | 3 | 0 | ST's chat-stats endpoint maps to neo's corpus analytics (planned/partly built) + the /_debug surface. |
| **groups** | 🎯 WANT | 4 | 0 | multi-character RP — a real ST capability we lack; sizable, not yet scoped. |
| **assets** | ✅ HAVE | 8 | 2 | content-addressed blob store by hash; ST splits into avatars/thumbnails/backgrounds/sprites. |
| **auth** | ✅ HAVE | 25 | 13 | BFF cookie + OIDC + per-user AES-GCM credentials + admin ladder. ST stores secrets PLAINTEXT — neo-stronger. |
| **characters** | ✅ HAVE | 16 | 5 | library + copy-on-write versioned editor; avatars via assets. |
| **chat** | ✅ HAVE | 13 | 17 | send/swipe/edit/fork/branch/compaction — the full turn pipeline. |
| **import-export** | ✅ HAVE | 0 | 5 | PNG card + JSONL chat import/export. |
| **meta** | ✅ HAVE | 0 | 3 | health/echo utility. |
| **personas** | ✅ HAVE | 0 | 5 | first-class persona router; ST has no dedicated endpoint (lives in settings). |
| **presets** | ✅ HAVE | 3 | 5 | versioned prompt presets (PromptConfig blob). |
| **providers** | ✅ HAVE | 62 | 7 | narrow by design: Claude (Max-sub + OpenRouter skin) + the OpenRouter catalog/account. ST proxies ~25 providers — the rest is OUT. |
| **settings** | ✅ HAVE | 6 | 6 | typed AppSettings/UserSettings; one dark theme, no switcher by design. |
| **tags** | ✅ HAVE | 0 | 7 | first-class tag router + typed junction tables. |
| **world-info** | ✅ HAVE | 5 | 10 | deliberately simpler than ST (scope-driven activation; no recursion/secondary keys). |
| **content-mgr** | 🚫 OUT | 2 | 0 | ST default-content downloader. |
| **extensions** | 🚫 OUT | 8 | 0 | no third-party extension system (single-user; the whole point of avoiding ST's event bus). |
| **image-gen** | 🚫 OUT | 27 | 0 | no image-gen / Stable-Diffusion / caption / classify (slop guard). |
| **maintenance** | 🚫 OUT | 7 | 0 | ST file-maintenance / backups; SQLite + the DB-ops tooling handle this differently. |
| **quick-replies** | 🚫 OUT | 2 | 0 | UI macro/quick-reply feature, not core. |
| **tokenizers** | 🚫 OUT | 35 | 0 | neo tokenizes internally (native tokenizer); not an endpoint. |
| **translate** | 🚫 OUT | 8 | 0 | no translation (slop guard). |
| **tts** | 🚫 OUT | 2 | 0 | no TTS/STT (slop guard). |
| **ui-cosmetic** | 🚫 OUT | 12 | 0 | themes / backgrounds / sprites / moving-ui — one dark theme, no switcher (slop guard). |
| **web-search** | 🚫 OUT | 8 | 0 | ST web / YouTube / SearXNG search — not an RP/corpus feature. |

## Per-domain detail

### rag — 🟣 NEO-ONLY
_corpus semantic search + analytics — the killer differentiator. ST 'vector' is per-chat retrieval only; ST 'search' is web search._

- **ST (7):** `POST /api/vector/delete`, `POST /api/vector/insert`, `POST /api/vector/list`, `POST /api/vector/purge`, `POST /api/vector/purge-all`, `POST /api/vector/query` …
- **neo (8):** `corpus.embed (mutation)`, `search.corpus (query)`, `search.digests (query)`, `search.discover (query)`, `search.find (query)`, `search.images (query)` …

### stats-analytics — 🟣 NEO-ONLY
_ST's chat-stats endpoint maps to neo's corpus analytics (planned/partly built) + the /_debug surface._

- **ST (3):** `POST /api/stats/get`, `POST /api/stats/recreate`, `POST /api/stats/update`
- **neo (0):** _none_

### groups — 🎯 WANT
_multi-character RP — a real ST capability we lack; sizable, not yet scoped._

- **ST (4):** `POST /api/groups/all`, `POST /api/groups/create`, `POST /api/groups/delete`, `POST /api/groups/edit`
- **neo (0):** _none_

### assets — ✅ HAVE
_content-addressed blob store by hash; ST splits into avatars/thumbnails/backgrounds/sprites._

- **ST (8):** `POST /api/assets/character`, `POST /api/assets/delete`, `POST /api/assets/download`, `POST /api/assets/get`, `POST /api/files/delete`, `POST /api/files/sanitize-filename` …
- **neo (2):** `GET /api/blob/:hash`, `POST /api/assets/upload`

### auth — ✅ HAVE
_BFF cookie + OIDC + per-user AES-GCM credentials + admin ladder. ST stores secrets PLAINTEXT — neo-stronger._

- **ST (25):** `GET /api/users/me`, `POST /api/secrets/delete`, `POST /api/secrets/find`, `POST /api/secrets/read`, `POST /api/secrets/rename`, `POST /api/secrets/rotate` …
- **neo (13):** `GET /api/auth/callback`, `GET /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `credentials.clearMyOpenRouterKey (mutation)`, `credentials.hasMyOpenRouterKey (query)` …

### characters — ✅ HAVE
_library + copy-on-write versioned editor; avatars via assets._

- **ST (16):** `POST /api/avatars/delete`, `POST /api/avatars/get`, `POST /api/avatars/upload`, `POST /api/characters/all`, `POST /api/characters/chats`, `POST /api/characters/create` …
- **neo (5):** `character.create (mutation)`, `character.get (query)`, `character.list (query)`, `character.remove (mutation)`, `character.update (mutation)`

### chat — ✅ HAVE
_send/swipe/edit/fork/branch/compaction — the full turn pipeline._

- **ST (13):** `POST /api/chats/delete`, `POST /api/chats/export`, `POST /api/chats/get`, `POST /api/chats/group/delete`, `POST /api/chats/group/get`, `POST /api/chats/group/import` …
- **neo (17):** `chat.archive (mutation)`, `chat.compact (mutation)`, `chat.delete (mutation)`, `chat.editMessage (mutation)`, `chat.fork (mutation)`, `chat.get (query)` …

### import-export — ✅ HAVE
_PNG card + JSONL chat import/export._

- **ST (0):** _none_
- **neo (5):** `GET /api/export/character/:characterId`, `GET /api/export/chat/:chatId`, `POST /api/import/cards`, `POST /api/import/chats`, `POST /api/import/zip`

### meta — ✅ HAVE
_health/echo utility._

- **ST (0):** _none_
- **neo (3):** `GET /api/healthz`, `echo (query)`, `health (query)`

### personas — ✅ HAVE
_first-class persona router; ST has no dedicated endpoint (lives in settings)._

- **ST (0):** _none_
- **neo (5):** `persona.create (mutation)`, `persona.get (query)`, `persona.list (query)`, `persona.remove (mutation)`, `persona.update (mutation)`

### presets — ✅ HAVE
_versioned prompt presets (PromptConfig blob)._

- **ST (3):** `POST /api/presets/delete`, `POST /api/presets/restore`, `POST /api/presets/save`
- **neo (5):** `preset.create (mutation)`, `preset.get (query)`, `preset.list (query)`, `preset.remove (mutation)`, `preset.update (mutation)`

### providers — ✅ HAVE
_narrow by design: Claude (Max-sub + OpenRouter skin) + the OpenRouter catalog/account. ST proxies ~25 providers — the rest is OUT._

- **ST (62):** `POST /api/anthropic/caption-image`, `POST /api/azure/generate`, `POST /api/azure/list`, `POST /api/backends/chat-completions/bias`, `POST /api/backends/chat-completions/generate`, `POST /api/backends/chat-completions/process` …
- **neo (7):** `models (query)`, `orActivity (query)`, `orCredits (query)`, `orEndpoints (query)`, `orGenerationCost (query)`, `orProviders (query)` …

### settings — ✅ HAVE
_typed AppSettings/UserSettings; one dark theme, no switcher by design._

- **ST (6):** `POST /api/settings/get`, `POST /api/settings/get-snapshots`, `POST /api/settings/load-snapshot`, `POST /api/settings/make-snapshot`, `POST /api/settings/restore-snapshot`, `POST /api/settings/save`
- **neo (6):** `settings.getAppSettings (query)`, `settings.getGlobalSetting (query)`, `settings.getUserSettings (query)`, `settings.setGlobalSetting (mutation)`, `settings.updateAppSettings (mutation)`, `settings.updateUserSettings (mutation)`

### tags — ✅ HAVE
_first-class tag router + typed junction tables._

- **ST (0):** _none_
- **neo (7):** `tag.attach (mutation)`, `tag.create (mutation)`, `tag.detach (mutation)`, `tag.get (query)`, `tag.list (query)`, `tag.remove (mutation)` …

### world-info — ✅ HAVE
_deliberately simpler than ST (scope-driven activation; no recursion/secondary keys)._

- **ST (5):** `POST /api/worldinfo/delete`, `POST /api/worldinfo/edit`, `POST /api/worldinfo/get`, `POST /api/worldinfo/import`, `POST /api/worldinfo/list`
- **neo (10):** `worldInfo.createBook (mutation)`, `worldInfo.createEntry (mutation)`, `worldInfo.getBook (query)`, `worldInfo.getEntry (query)`, `worldInfo.listBooks (query)`, `worldInfo.listEntries (query)` …

### content-mgr — 🚫 OUT
_ST default-content downloader._

- **ST (2):** `POST /api/content/importURL`, `POST /api/content/importUUID`
- **neo (0):** _none_

### extensions — 🚫 OUT
_no third-party extension system (single-user; the whole point of avoiding ST's event bus)._

- **ST (8):** `GET /api/extensions/discover`, `POST /api/extensions/branches`, `POST /api/extensions/delete`, `POST /api/extensions/install`, `POST /api/extensions/move`, `POST /api/extensions/switch` …
- **neo (0):** _none_

### image-gen — 🚫 OUT
_no image-gen / Stable-Diffusion / caption / classify (slop guard)._

- **ST (27):** `POST /api/extra/caption`, `POST /api/extra/classify`, `POST /api/extra/classify/labels`, `POST /api/image-metadata`, `POST /api/image-metadata/all`, `POST /api/image-metadata/cleanup` …
- **neo (0):** _none_

### maintenance — 🚫 OUT
_ST file-maintenance / backups; SQLite + the DB-ops tooling handle this differently._

- **ST (7):** `GET /api/data-maid/view`, `POST /api/backups/chat/delete`, `POST /api/backups/chat/download`, `POST /api/backups/chat/get`, `POST /api/data-maid/delete`, `POST /api/data-maid/finalize` …
- **neo (0):** _none_

### quick-replies — 🚫 OUT
_UI macro/quick-reply feature, not core._

- **ST (2):** `POST /api/quick-replies/delete`, `POST /api/quick-replies/save`
- **neo (0):** _none_

### tokenizers — 🚫 OUT
_neo tokenizes internally (native tokenizer); not an endpoint._

- **ST (35):** `POST /api/tokenizers/claude/decode`, `POST /api/tokenizers/claude/encode`, `POST /api/tokenizers/command-a/decode`, `POST /api/tokenizers/command-a/encode`, `POST /api/tokenizers/command-r/decode`, `POST /api/tokenizers/command-r/encode` …
- **neo (0):** _none_

### translate — 🚫 OUT
_no translation (slop guard)._

- **ST (8):** `POST /api/translate/bing`, `POST /api/translate/deepl`, `POST /api/translate/deeplx`, `POST /api/translate/google`, `POST /api/translate/libre`, `POST /api/translate/lingva` …
- **neo (0):** _none_

### tts — 🚫 OUT
_no TTS/STT (slop guard)._

- **ST (2):** `POST /api/speech/recognize`, `POST /api/speech/synthesize`
- **neo (0):** _none_

### ui-cosmetic — 🚫 OUT
_themes / backgrounds / sprites / moving-ui — one dark theme, no switcher (slop guard)._

- **ST (12):** `GET /api/sprites/get`, `POST /api/backgrounds/all`, `POST /api/backgrounds/delete`, `POST /api/backgrounds/folders`, `POST /api/backgrounds/rename`, `POST /api/backgrounds/upload` …
- **neo (0):** _none_

### web-search — 🚫 OUT
_ST web / YouTube / SearXNG search — not an RP/corpus feature._

- **ST (8):** `POST /api/search/koboldcpp`, `POST /api/search/searxng`, `POST /api/search/serpapi`, `POST /api/search/serper`, `POST /api/search/tavily`, `POST /api/search/transcript` …
- **neo (0):** _none_

## 🎯 Gap to build (WANT)

- **groups** — multi-character RP — a real ST capability we lack; sizable, not yet scoped.

## 🟣 neo-only differentiators

- **rag** — corpus semantic search + analytics — the killer differentiator. ST 'vector' is per-chat retrieval only; ST 'search' is web search.
- **stats-analytics** — ST's chat-stats endpoint maps to neo's corpus analytics (planned/partly built) + the /_debug surface.

## 🚫 Deliberately out of scope (anti-slop — do NOT build)

- **content-mgr** — ST default-content downloader.
- **extensions** — no third-party extension system (single-user; the whole point of avoiding ST's event bus).
- **image-gen** — no image-gen / Stable-Diffusion / caption / classify (slop guard).
- **maintenance** — ST file-maintenance / backups; SQLite + the DB-ops tooling handle this differently.
- **quick-replies** — UI macro/quick-reply feature, not core.
- **tokenizers** — neo tokenizes internally (native tokenizer); not an endpoint.
- **translate** — no translation (slop guard).
- **tts** — no TTS/STT (slop guard).
- **ui-cosmetic** — themes / backgrounds / sprites / moving-ui — one dark theme, no switcher (slop guard).
- **web-search** — ST web / YouTube / SearXNG search — not an RP/corpus feature.

## Layer map: ST → neo's shared/server/client

ST splits cleanly into **server (`src/`)** and **client (`public/`)** — but has **no `shared` layer**. The logic neo factors into `src/shared/` is, in ST, client-side or duplicated across both. That absence (and the resulting duplication) is one of the sharpest structural differences.

| neo `shared/` concern | ST layer | ST location | Note |
|---|---|---|---|
| `shared/macro/* (macro engine)` | client | `public/scripts/macros/macro-system.js + definitions/*` | ST runs macros CLIENT-side; neo centralizes them server-side in shared. |
| `shared/prompt-assemble + prompt-config` | split | `public/script.js Generate() + src/prompt-converters.js` | ST splits prompt build across client + a server converter; neo has ONE shared assembler with a cache boundary. |
| `shared/regex (script engine)` | client-ext | `public/scripts/extensions/regex/{index,engine}.js` | ST's regex scripts are a CLIENT EXTENSION; neo bakes the engine into shared + server _shared/regex. |
| `shared/generation (params vocab)` | client | `public/scripts/*settings UI state` | ST generation knobs live in client settings; neo: one provider-agnostic shared vocab translated per runner. |
| `shared/models (catalog)` | client | `public/scripts model constants` | client-side lists; neo: a shared static Claude catalog + the live OpenRouter catalog. |
| `shared/time (epoch-ms, the only parser)` | none | `scattered inline Date handling` | ST has NO central time util; neo: shared/time.ts is the sole parser (epoch-ms UTC everywhere). |
| `shared/chat-types + Zod-derived types` | none | `implicit (untyped JS)` | ST has no shared type layer; neo derives TS types from Zod schemas as the single source of truth. |

## Frontend surface inventory

_Surface-area only (file/LOC counts), not a call-graph. ST's client is the bulk of the project; neo's client is largely stubs pending the UI build._

**neo client:** 3 files / 13 LOC (mostly `.gitkeep` stubs under `src/client/features/*`).

**ST client (`public/scripts/`) by area:**

| Area | files | LOC |
|---|--:|--:|
| `(root)` | 75 | 79,174 |
| `extensions` | 64 | 37,885 |
| `macros` | 18 | 6,171 |
| `autocomplete` | 11 | 4,646 |
| `slash-commands` | 27 | 4,095 |
| `util` | 7 | 674 |
