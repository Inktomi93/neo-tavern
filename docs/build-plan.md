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
  Also the app shell: the `Chat | Corpus | Characters` nav rail (`docs/ui-direction.md`).
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
  visual **embed pass** (embed FROM the blob by hash) is the remaining follow-up. See `docs/assets.md`.

**Next big workstream — DESIGN LOCKED, not yet built:** pluggable auth (`single-user` default /
`forward-header` / `oidc`) + a user layer (`OWNER_GROUP`/`OWNER_HANDLES`→admin, `users.externalId`/
`enabled`) + encrypted per-user credentials (BYO OpenRouter key) gated by one turn-time **credential
resolver**. Bearer-token sessions, no cookies/CSRF. Full exhaustive spec (incl. ground-truth authentik
endpoints/headers from the live stack): **`docs/auth-and-credentials-plan.md`**.

**Untracked sub-items (fold into the issues above when they land):**
- Character library + a FOCUSED editor (name/description/personality/scenario/greetings/
  system-prompt/world-info — not ST's 47 fields) + a World Info editor (`always` vs `keyword`). (≈ #45.)
- Alternate greetings → `message_variants` on import (importer write side; uses the swipe machinery).
- Analytics (Phase 6): `domain` queries + `features` charts (`recharts`), one chart at a time.
- Install per-feature deps as they land (knip flags dead deps) — see `docs/dependencies.md`.

## Why chat before the corpus (which is also the product)

Chat was the cheapest end-to-end slice — it proved the full stack (db → domain → transport →
client) with less complexity than RAG, so the architecture got exercised early. The corpus
product then built on rails that already carried weight.
