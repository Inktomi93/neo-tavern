# Settings / profile / config audit — toward ST parity

> **STATUS: RESOLVED + IMPLEMENTED** (commits `f687c17`, `5e7bb4c`, `ed05474`). The audit's findings
> stood; the proposal shipped with owner-signed-off refinements. See **"What shipped"** at the bottom
> for the as-built surface and decisions. The original audit is kept below for the *why*.

Audit of the config surface (env knobs, user settings, user profile) against the "bring settings up
to SillyTavern parity" goal. The headline correction is that **`env.ts` is not the problem** — the
gap was that **user settings were a schemaless blob**.

## The three config tiers (where things live)

| Tier | Mechanism | Scope | State today |
| --- | --- | --- | --- |
| **Deploy-time** | `env.ts` (Zod-validated `process.env`) | per-deployment | ✅ coherent, well-documented |
| **Per-chat prompt+generation** | preset `config` (`PromptConfig` + `GenerationParams`) | per-chat (pinned version) | ✅ typed, versioned, copy-on-write |
| **Per-user runtime** | `user_settings.config` | per-user | ❌ **schemaless `json` blob, `z.any()`** |

## Finding 1 — env.ts is fine (not "weird"); leave it
Every knob is a legitimate **deploy-time** concern, each with a load-bearing comment: `PORT`,
`NODE_ENV`, `OPENROUTER_API_KEY`, `LOG_LEVEL`, `DEBUG_TOKEN`, `DATABASE_URL`, `ASSETS_DIR`,
`EMBED_*`/`RERANK_*`/`*_GPU_ID`/`IDLE_UNLOAD_MIN`/`SUMMARIZER_GGUF`/`MODEL_CACHE_DIR` (GPU/model infra),
`CORPUS_AUTOINDEX`, `IMPORT_SKIP_CHARACTERS`, `DEFAULT_USER_HANDLE`, `NEO_PROXY_SECRET`. These belong
in env (they set up the box, not the user's preferences). **No action** beyond what's below.
- One *seam* worth noting, not fixing: `IMPORT_SKIP_CHARACTERS` is arguably a per-user/runtime curation
  pref, not deploy config. Candidate to move into user settings later. Low priority.

## Finding 2 — `user_settings` is the real gap: a schemaless blob
`user_settings` = `{ userId, schemaVersion, config: json, updatedAt }`. The service stores
`config: input.config` verbatim; the router validates it as **`z.any()`** (`settings.ts`); the default
is `{}`. So there is **no contract for what a user setting IS** — nothing is typed, nothing is
defaulted, nothing is read by the rest of the app. This is the "weird config" — not env, but the
*absence of a user-settings schema*. Presets got a real typed/versioned `config`; user settings never did.

## Finding 3 — user profile is minimal
`users` = `{ id, handle, displayName, createdAt }`. Fine for the single-user posture, but thin vs ST
(no avatar, no default-persona pointer, no per-user defaults). Profile and per-user defaults overlap
with Finding 2 — both want a typed home.

## What SillyTavern has (target surface)
ST's user/power-user settings include: default persona + persona management, default preset/API/model,
default sampler params, instruct-mode + context templates (text-completion only — **out of scope**
here, our APIs are chat-native), UI/theme prefs (mostly **out of scope** — one locked dark theme),
auto-save/streaming toggles, and assorted behavior flags. The **in-scope** subset for us: per-user
**defaults** (preset, persona, provider/model, generation knobs) + a few behavior prefs.

## Proposal (awaiting sign-off) — give user settings a typed schema

1. **`shared/user-settings.ts`** — a Zod `userSettingsSchema` + `UserSettings` type + `parseUserSettings`
   (lenient: accepts the existing blob, fills defaults — so no migration breakage), mirroring how
   `shared/prompt-config.ts` + `shared/generation.ts` are done. Candidate fields (all optional):
   - `defaultPresetId?: string | null` — preset new chats pin (today they use `DEFAULT_PROMPT_CONFIG`).
   - `defaultPersonaId?: string | null` — persona new chats open with.
   - `defaultApi` / `defaultSource` / `defaultModel` — routing defaults for new chats (the 4-mode tuple).
   - `defaultGeneration?: GenerationParams` — default knobs (now that samplers are plumbed).
   - small behavior prefs as they prove needed (e.g. `generateOpeningByDefault`).
2. **Type the router + service**: replace `z.any()` with `userSettingsSchema`; `getUserSettings` returns
   a parsed (defaulted) object; `updateUserSettings` validates. Keep `schemaVersion` for future migrations.
3. **Wire the defaults** where they matter (the riskier, behavior-changing step — do last, with care):
   `chat.create` reads the user's defaults (preset/persona/api/model/generation) when the caller
   doesn't specify. This is what makes settings actually *do* something.
4. **Profile**: optionally add `users.avatarAssetId` + expose a small profile read/update; or fold a
   `profile` block into user settings. Decide after (1).

### Safety / sequencing
- (1)+(2) are **additive + low-risk** (lenient parse means existing `{}` blobs keep working) and
  independently testable (schema accept/reject, default-fill). Ship these first.
- (3) changes `chat.create` behavior — gate behind tests + a checkpoint commit; it's the only risky part.
- Pairs with the now-shipped **sampler params** (`GenerationParams` extended) — `defaultGeneration`
  would expose them per-user.
- Do **not** add instruct/context-template or theme settings — out of scope (chat-native APIs; one dark theme).

## Open decisions for the owner (now resolved — see "What shipped")
- Exact `UserSettings` field set · Profile home · seed-vs-override · the AppSettings subset · admin gate.

---

# What shipped

## Three config tiers, all typed now
| Tier | Mechanism | Contract |
| --- | --- | --- |
| **Deploy-time / box / secret** | `env.ts` (Zod) | unchanged — bootstrap, GPU infra, secrets, identity/trust. |
| **App-wide runtime toggles** | `AppSettings` over the `settings` KV (`shared/app-settings.ts` + `server/config/app-config.ts`) | typed; env is the default FLOOR, an admin DB override wins at runtime. **Admin-gated** (`requireAdmin`). |
| **Per-user** | `user_settings.config` → `UserSettings` (`shared/user-settings.ts`) | typed, lenient (`parseUserSettings`), versioned. Seeds new-chat defaults. |

## UserSettings (per-user)
Fields: `defaultPresetId`, `defaultPersonaId`, `defaultApi/Source/Model`, `defaultGeneration`
(**stored, not consumed** — your default preset's params ARE your samplers; see [[the lazy-create
note]]), `profile.avatarAssetId` (`displayName` stays on `users`), `regexScripts`. Per-field `.catch`
so one bad field self-heals. **Seed semantics** (caller arg → user default → schema default): wired
into `chat.startChat`; lenient at consumption (a stale preset/persona id degrades to null).

## AppSettings (admin runtime config) + the server-config triage
The DB-backable subset of `env.ts`: `corpusAutoindex`, `importSkipCharacters`, `logLevel`,
`idleUnloadMin`. The **boundary rule**: env stays the home for (a) bootstrap (can't read DB config
before the DB exists; caddy serves `ASSETS_DIR`), (b) physical GPU/box infra (need `LD_LIBRARY_PATH`
before onnxruntime loads; restart-required), (c) secrets/identity/trust (`OPENROUTER_API_KEY`,
`DEBUG_TOKEN`, `NEO_PROXY_SECRET`, `DEFAULT_USER_HANDLE`). AppSettings is only runtime operational
toggles.

**Why the surface is small (ST `config.yaml` triage):** ~90% of ST's 394-line `config.yaml` is
network/TLS/auth/SSO/whitelist/rate-limit — **delegated entirely to caddy + authentik** in our
deploy (ST even has `sso.authentikAuth` + `trustedProxies` — literally our model, in-app). The
provider-caching block (`claude.enableSystemPromptCache`/`cachingAtDepth`/`extendedTTL`) we **fix in
code + per-preset by design** (a misconfigurable money-waster as a toggle). The rest (`backups`,
`thumbnails`, `extensions`, `performance`) is config for features we don't have. What remained that's
a genuine runtime toggle *and* applies to us is the 4 knobs above.

## Admin gate (multi-user seam)
`users.role` (`'admin'|'user'`, migration 0025; default `'user'` — backfill promoted the owner).
`ensureUser` provisions `role:'admin'` iff `handle === DEFAULT_USER_HANDLE` (the one access decision,
in one place — no escalation-by-default). `requireAdmin` (`_shared/admin.ts`) → `DomainForbiddenError`
→ tRPC FORBIDDEN gates the AppSettings read/write.
