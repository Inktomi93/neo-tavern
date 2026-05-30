# Build plan

This file holds two things that don't rot: **the de-risk spike results** (load-bearing tech
bets, validated once) and **the deferred backlog** (what's left to build). Per-feature status
is NOT narrated here — that's the git log + the code. The one-line phase status below is the
only ✅-tracking in the repo; keep it one line.

## Principles

- **Bottom-up, de-risk first.** Build the foundation before what sits on it (db → domain →
  transport → client); validate load-bearing bets with throwaway spikes before pouring
  concrete. A wrong assumption should cost a 20-minute spike, not a rebuild.
- **Isolation contains churn.** Feature isolation is `dependency-cruiser`-enforced (a
  `domain/<feature>` literally cannot import another), schema growth is additive migrations,
  and the router/context are append-only seams. So building one feature can't force edits to
  another. Decide **cross-cutting** choices first (they're the only thing isolation doesn't
  protect); isolated features whenever.

## Step 0 — de-risk spikes ✅ (all passed, no pivots)

| Bet | Result |
| --- | --- |
| **Agent-SDK chat** | `resume` retains context across turns; `forkSession()` / truncated-resume branch cleanly; the DB-backed `SessionStore` is the resume source (disk JSONL is throwaway). |
| **Vector store** | libSQL native `F32_BLOB` + `libsql_vector_idx` + `vector_distance_cos`/`vector_top_k` all work — **no sqlite-vec extension.** |
| **Local embeddings** | `@huggingface/transformers` ONNX runs in-process; BGE-M3 (1024-dim) on the CUDA EP is ~24× CPU. |

## Phase status (one line each — the only ✅ tracking; details = git log + code)

- **Phase 1–2 — scaffold, schema, first chat:** ✅
- **Phase 3 — embeddings foundation (BGE-M3 + libSQL vectors):** ✅
- **Phase 4 — ST importer + RAG search (CSLS + rerank + `discover` + `/corpus` UI) + enforced
  FKs (migration 0007):** ✅ **The corpus product is end-to-end usable.**
- **Phase 5 — chat-first frontend + the 4 provider modes:** **CURRENT.** Chat backend is
  effectively complete: prompt assembly + the 4 modes (incl. mode-2 OpenRouter skin),
  swipes/edits/fork/seeding, `setProvider`, the read API (`chat.list`/`get`/`messages` with
  provenance), `chat.previewAssembly` (dry-run "what will this send" without spending a turn),
  one unified `GenerationParams` vocab, canonical epoch-ms-UTC time, managed compaction +
  cross-mode `{{compact_summary}}`, persisted `chat_events`, the preset CRUD service (#43,
  `preset.*` router), the content-addressed asset store (#47 infra), and the `/api/_debug` read
  surface, `chats.pinnedPersonaId` (#44), the `{{memory}}` marker (#40). **The chat backend is
  now complete** — the chat frontend that renders all of it is what's left. See backlog.
- **Phase 6 — analytics:** not started (one chart at a time, only for a real question).

## Deferred backlog (what's parked + where it belongs)

`#NN` = the owner's issue tracker (keep these in sync — this list maps 1:1 to the open issues).

**Chat frontend (the bulk of what's left in Phase 5):**
- **#37 — error-state UI** (quick, ~20 min, independent): the `send`/`swipe` `status:"error"`
  result (with `code`/`retryable`/`resetsAt`, after rollback) has no UI yet — only
  `status:"stale"` is handled. Render the error variant (e.g. "rate-limited, resets at X; retry").
- **#45 — chat UX polish** ("prettier SillyTavern", build incrementally): sanitized markdown
  (react-markdown + remark-gfm + rehype-sanitize), avatars + message styling, the chat list, the
  swipe UI (`← 3/5 →` over `message_variants`), a provider/model picker (wiring `setProvider` +
  the `models`/`rawModels` queries), the context-fill meter (`contextWindow` is captured per
  turn), list virtualization (`@tanstack/react-virtual`) for long chats / the 400+ char library.
  Also the app shell: the `Chat | Corpus | Characters` nav rail (`docs/planning/ui-direction.md`).
- **#43 — preset CRUD service ✅ DONE; prompt-manager editor (frontend) remaining**: `domain/preset`
  copy-on-write over the `presets`/`preset_versions` triad is BUILT — create/list/get/update/delete +
  the tRPC `preset.*` router; editing config mutates an unpinned version in place, forks `v=max+1` +
  repoints when the current version is pinned by a chat/message (immutable provenance), owner-scoped.
  **Left (frontend):** the editor UI (drag-reorder `PromptConfig` sections, per-section toggles, edit
  literal/marker content, the cache boundary as a draggable section — Marinara's `PresetEditor` =
  reference) AND the **chat↔preset picker** that sets `chats.presetVersionId` (today chats use
  `DEFAULT_PROMPT_CONFIG`; the service + read path are ready for it).

**Runtime / engine:**
- **#42 — streaming: backend BUILT; client + push remain.** Token deltas are wired end-to-end —
  all three runners (sdk `includePartialMessages`/`stream_event`; openrouter chat-completions +
  responses) → `onDelta` → `chatStreamEmitter` → the tRPC `streamMessages` subscription. **Left:**
  the *client* streaming UI that renders the deltas (frontend); **cross-client live-push fan-out**
  (the auto-refresh half — today it converges on refresh); and the Caddy config (disable proxy
  buffering for `text/event-stream` + keepalives).
- **#48 — raw-mode refinements:** (1) granular raw caching — `cache_control` breakpoints at the
  static/dynamic split / history depth (à la ST), beyond the current static-block 5m directive — still
  deferred (low priority).

**Infra / corpus:**
- **#46 — Docker/compose image + Playwright E2E**: one image into the authentik+caddy stack, port
  8788 (don't expose to untrusted nets — the header-trust invariant). One happy-path E2E per
  critical flow (chat turn, corpus search); no screenshot diffs.
- **#47 — corpus extras**: (1) find-similar / find-duplicates (cosine ≥ 0.92 `vector_top_k`
  self-join) — deferred. (2) Image embeddings for visual card similarity — **landing built**: the
  content-addressed asset store (`storage/cas.ts` + `domain/assets`: store/backfill/GC/fsck; avatars
  wired on import + `pnpm assets:backfill`) and the `image_embeddings` table (migration 0016,
  SigLIP-2 so400m **1152-dim**, its own `libsql_vector_idx` — NOT the 1024-dim text space). The
  visual **embed pass** (embed FROM the blob by hash) is the remaining follow-up. See `docs/subsystems/assets.md`.
- **#49 — import/fork write atomicity (LOW priority, deferred):** `importCharacter` writes a deep FK
  graph (version→book→entries→junction→character→chats→messages) that is NOT under `withChatLock` and
  has NO compensating rollback, so a crash mid-import can leave partial rows. Tolerable today: rare,
  single-user, largely re-runnable (handle + `importHash` dedup heals most re-runs). **Do NOT "fix"
  with `db.transaction()`** — it's banned (`:memory:` trap, `docs/architecture/conventions.md`; opens a fresh
  empty connection → breaks every in-memory test). The `:memory:`-safe path is **`db.batch()`**
  (libSQL atomic, same-connection) — currently 0 uses, so it needs a `:memory:` validation first.
  The chat turn is already atomic via `withChatLock` + compensating rollback (`send.ts`); this is
  only the non-locked bulk-insert paths (import, and to a lesser degree `forkChat`).
- **#50 — Guided Generations (the steering actions, frontend-era):** the features the owner actually
  uses from `references/guided-generations` — **guided response, guided swipe, guided impersonate,
  rewrite / edit-intro**. They collapse to ONE parameterized `guidedTurn` on primitives we already
  have — NOT a port of ST's QR/STscript (that's just ST's delivery for "inject + generate"):
  - **Ephemeral guidance injection** — a one-turn instruction added to the **dynamic** (post-cache-
    boundary) system prompt; never enters the append-only `messages` log, never busts the cached
    prefix. Powers **guided response** (= `send` + inject) and **guided swipe** (type guidance →
    generate a NEW swipe of the last assistant message *under that guidance* — it does NOT reuse or
    re-roll an existing swipe's text; our `swipe` verb already produces a fresh `message_variants`
    variant, so guided swipe = `swipe` + inject).
  - **Rewrite / edit-intro** — "regenerate THIS message under instruction X" → a new
    `message_variants` swipe (reuses `editMessage` + the variant machinery). The intro-reformat menu
    (POV/tense/style) is just canned instruction strings.
  - **Impersonate** — generate as the persona/POV; result lands in the **client draft**, not canon.
  - **Per-action EDITABLE prompt templates** (REQUIRED) — every action's prompt is a user-editable
    string with `{{input}}`/`{{char}}`/`{{user}}` via the macro engine, so users can change them.
  - **Injection `role` settable** (system/user/assistant) per action [+ optional depth].
  - **NO per-action profile/preset switching** — owner is single-model; explicitly dropped (GG has
    it; we don't need it).
  - Persistent Guides (state/tracker/clothes) is the separate **variables/state** capability (the
    macro-audit gap), NOT part of this — owner doesn't use it.
  - **POV via preset-variables, NOT hardcoded buttons:** the cleanest POV mechanism is Marinara's
    `ChoiceBlock` pattern — a preset defines named variables (`{{POV}}`, tense, …) with a
    question + options, user picks per chat, injected via the macro engine. This unifies POV +
    the macro `variables` gap in one feature on our `PromptConfig`. See `docs/reference/marinara-reference.md`
    (her engine = her ST preset productized) for the full pattern + `file:line` refs.
- **#51 — config/settings standardization (typed · migrateable · cleanable):** unify the typed-blob
  config tiers so the migration pattern is one thing you can't half-implement or forget. Today the
  "versioned blob + lift loop" is **copy-pasted** in `shared/user-settings.ts` + `shared/prompt-config.ts`
  ("Mirrors prompt-config"), and `shared/app-settings.ts` has the version constant but no lift loop.
  Build, in priority order:
  1. **`shared/versioned-config.ts` primitive** (high value, low risk): a `defineVersionedConfig({
     schema, version, lifts })` → `{ parse, serialize, default, version }` owning the lift-walk loop
     ONCE. AppSettings / UserSettings / PromptConfig all adopt it. Kills the copy-paste; one identical
     migration mechanism everywhere.
  2. **The "can't-forget" guardrail** (THE point — owner forgets to bump+lift): **fixture migration
     tests** — keep real blobs at each historical version under `__fixtures__/`; a test asserts each
     still parses to the current shape with no data loss. Break a schema without a lift → red →
     `pnpm check` blocks the commit. Plus a registry + meta-test (every versioned config must have a
     current-version fixture) and a `default.schemaVersion === currentVersion` dev-assert. Converts
     "remember to migrate" from willpower into an enforced gate (same posture as the dep-cruiser layer
     check). The test remembers so you don't.
  3. **Cleanable** (small): the primitive's `default` gives uniform reset — `AppSettings.clearOverride()`
     (drop the KV row → env floor), `UserSettings.reset(userId)` (write default). Orphan pruning is
     mostly FK-cascade already; a settings-prune slots into the `jobs`/maintenance seam if needed.
  4. **Env hot-reload (DEFERRED — lower value than it feels):** borrow Marinara's `reloadRuntimeEnv`
     (re-read `.env`, override changed keys, delete removed — no restart; `marinara-engine/.../config/
     runtime-config.ts`). BUT AppSettings already gives runtime hot-override for the toggles that
     matter; the only real marginal win is **live secret rotation** (e.g. `OPENROUTER_API_KEY`). Cost
     is real: `env` is a captured const (`env.ts:185`) at ~24 call-sites → needs a `getEnv()` getter
     (or live proxy), boot-only fields (`PORT`/DB path/`AUTH_MODE`) marked reload-refusing, and a
     trigger (admin route or chokidar `.env` watch). Do ONLY if live secret rotation becomes a real
     need; scope to the rotating secrets, not all of env.
  Recommended: ship 1+2+3 together (the standardize/typed/cleanable/can't-forget core); park 4.

**Pluggable auth + user/credential foundation — BUILT (migrations 0025–0026 + the `feat(auth)`
commits) and verified live through the real caddy+authentik stack.** Pluggable `AUTH_MODE`
(`single-user` default / `forward-header` (JWKS-verified) / `oidc`) + `AUTH_FALLBACK`; a user layer
(`OWNER_GROUP`/`OWNER_HANDLES`→admin, `users.externalId`/`enabled`, `provisionIdentity`); the tRPC
procedure ladder (public→authed+CSRF→admin); revocable server-side **`sessions`** in an
**HttpOnly/Secure/SameSite=Lax cookie (BFF)** with a custom-header CSRF mitigation (NOT bearer tokens —
that early framing was superseded); encrypted per-user credentials (BYO OpenRouter key) gated by one
turn-time **credential resolver**; OIDC routes (openid-client v6). The *why* is
**`docs/auth/auth-and-credentials-plan.md`**; deploy recipe **`docs/auth/auth-deploy.md`**; verification runbook
**`docs/auth/auth-verify.md`** (`pnpm verify:auth`). Remaining auth-adjacent work: the **frontend** (login
UI, key-entry, user-admin screens) — see the client UI workstream.

**Untracked sub-items (fold into the issues above when they land):**
- Character library + a FOCUSED editor (name/description/personality/scenario/greetings/
  system-prompt/world-info — not ST's 47 fields) + a World Info editor (`always` vs `keyword`). (≈ #45.)
- Alternate greetings → `message_variants` on import (importer write side; uses the swipe machinery).
- Analytics (Phase 6): `domain` queries + `features` charts (`recharts`), one chart at a time.
- Install per-feature deps as they land (knip flags dead deps) — see `docs/architecture/dependencies.md`.

## Why chat before the corpus (which is also the product)

Chat was the cheapest end-to-end slice — it proved the full stack (db → domain → transport →
client) with less complexity than RAG, so the architecture got exercised early. The corpus
product then built on rails that already carried weight.
