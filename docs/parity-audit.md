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
| `worldinfo.js` | world-info | **IN** | 🔲 |
| `presets.js` | presets | **IN** | 🔲 |
| (none — client-only in ST) | personas | **IN** (neo first-classed it) | 🔲 |
| `openai.js`, `openrouter.js`, `anthropic.js`, `backends/` | providers | **IN** | ✅ done |
| `assets.js`, `files.js`, `thumbnails.js` | assets | **IN** | 🔲 |
| `secrets.js`, `users-admin.js`, `users-private.js`, `users-public.js` | auth | **IN** | 🔲 |
| `settings.js` | settings | **IN** | 🔲 |
| `tokenizers.js` | tokenizers | **IN** (internal, not an endpoint) | ✅ done |
| `vectors.js` | rag | **IN** (neo superset — corpus RAG) | 🔲 |
| `stats.js` | stats-analytics | **IN** (neo-evolved) | 🔲 |
| `image-metadata.js` | import (PNG tEXt) | **IN** (folded into import) | 🔲 |
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

### world-info — 🔲 pending (simpler scope LOCKED by owner 2026-05-29)
`pnpm api:q domain world-info` + `pnpm api:q hooks world-info`. ST `worldinfo.js` has recursion,
secondary (AND/NOT) keys, timed effects, probability, floating depth. **We intentionally do NOT
match those** — owner-confirmed. Our model = scope-driven activation (`always`→static,
`keyword`→dynamic, basic whole-word match, attached-only pool). So this audit is **not** a
gap-hunt against ST's advanced features (they're deliberately OUT); it's: *do we cover the basic
keyword + always-on case correctly and completely?* Subsystem: `world-info`, `prompt-assembly`.

### presets — 🔲 pending
`pnpm api:q domain presets`. ST `presets.js` vs our versioned `PromptConfig` blob
(`shared/prompt-config.ts`). Audit: prompt-section ordering, cache boundary, generation params,
regex scripts. Subsystems: `presets`, `prompt-manager`.

### personas — 🔲 pending
ST has **no** dedicated endpoint (client-only in `personas.js`); neo first-classed it
(`trpc/routers/persona.ts`). Audit what ST does client-side vs our router — likely a NEO win, verify.

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

### assets — 🔲 pending
`pnpm api:q domain assets`. ST splits avatars/thumbnails/backgrounds/sprites/files; we have one
content-addressed blob store (`GET /api/blob/:hash`, `POST /api/assets/upload`). Audit: upload,
fetch, the (intentional) absence of delete, file sanitization.

### auth — 🔲 pending
`pnpm api:q domain auth`. ST `secrets.js` (PLAINTEXT) + `users-*.js` vs our BFF cookie + OIDC +
per-user AES-GCM credentials + admin ladder (`auth/*`, migrations 0025–0026). Likely a strong NEO
win; verify the user-CRUD surface (`userAdmin` router) covers ST's users-admin.

### settings — 🔲 pending
`pnpm api:q domain settings`. ST `settings.js` (one big blob) vs our typed AppSettings/UserSettings
(`shared/app-settings.ts`, `shared/user-settings.ts`). Audit: what ST settings keys map to our
typed tiers vs are delegated to caddy/authentik vs dropped.

### rag / vectors — 🔲 pending
`pnpm api:q domain rag`. ST `vectors.js` = per-chat vector memory only; ours is the corpus RAG
superpower (NEO-ONLY). Audit = confirm we cover ST's per-chat use case AND document the superset.

### stats-analytics — 🔲 pending
`pnpm api:q domain stats-analytics`. ST `stats.js` (per-chat message stats) vs our planned corpus
analytics + `/api/_debug/*`. Audit: what ST stats we should match vs supersede.

### import (PNG metadata) — 🔲 pending
ST `image-metadata.js` reads PNG tEXt for cards; we fold this into `domain/import/card.ts`. Audit:
confirm we read the same tEXt/`ccv3` chunks ST writes, for round-trip compatibility.

---

## Deferred (owner-decided OUT for now, 2026-05-29)

### groups — 🚫 out for now
ST `groups.js` (4 routes) — multi-character RP. Real ST capability we lack; **deferred**, not
killed. Revisit when the single-char chat surface is solid. No audit this pass.

### ui-cosmetic — 🚫 out for now
ST `themes.js` / `backgrounds.js` / `moving-ui.js`. **Deferred** — the single dark theme stands.
No audit this pass.
