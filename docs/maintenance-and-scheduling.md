# Maintenance & scheduling — the design (decided, not yet built)

A forward-looking design decision, recorded **before** the need is acute, so future sessions slot
work into a seam instead of bolting on `setInterval` #6. This is the *why* and the *shape*; there is
**no scheduler module yet**. Single-user homelab today means almost nothing accumulates fast — this
doc exists so that when it does (or when the corpus/analytics work lands), the answer is already
decided. Status lives in the git log + the code, as always; this is the contract they should grow
into.

## The principle: one single-owner seam for scheduled work

Scheduled/maintenance work is **one concern with one owner** — the same pattern the codebase already
trusts: `resolveTurnRouting` owns model+provider selection, `resolveCredential` owns the credential
gate, `assemblePrompt` owns prompt structure. Here: **one `maintenance` module owns all scheduled
work.** Adding periodic work = registering a task in that registry, **never** a fresh `setInterval`
in some domain file. The smell this kills: timers scattered across modules, each unobservable,
restart-resetting, and uncoordinated — nobody able to answer "what does this server do on a
schedule?"

This is NOT an argument to build a platform (Inngest / Temporal / BullMQ). At single-instance scale
those solve a *distributed* problem we don't have and drag in Redis/Postgres/cloud that fights the
SQLite-only ethos (and Inngest can't even be fully self-hosted). The decision is the **seam**, sized
to a homelab: in-process, on the libSQL we already have.

## Two job shapes — design for both, even if only one is built first

| shape | trigger | nature | examples |
|---|---|---|---|
| **Recurring maintenance** | time (cron) | idempotent, "run X every N" | `PRAGMA optimize` + WAL checkpoint, blob GC, session prune, reindex |
| **Deferred one-shot job** | event | retryable, fallible, "do this once" | embed *this* card, generate digests for *this* chat, run *this* import |

Today the deferred work runs **inline in the request** (synchronous embedding/digest generation).
That is correct at one user. As the corpus grows, blocking a request on embedding/analysis is exactly
what you'll want to push to a background job. **A good seam hosts both behind one interface** — model
"scheduled work" (recurring + deferred), not "cron". Build the recurring half first; leave the
deferred half as a known second face of the same seam.

## The seam (what to build, when the first real task arrives)

1. **One registry module** — `server/maintenance/` (or similar). Tasks declared as
   `{ name, schedule, handler }` in one place. One file is the source of truth for "everything
   periodic."
2. **A durable table** — `scheduled_runs` (or a generic `jobs`) on the existing libSQL:
   `name, last_run, next_run, status, attempts, last_error`. This is the thing timers can never give:
   **durability across restart + observability** — surface it through the `/api/_debug/*` API so
   "what ran, when, did it fail" is a query, not a guess.
3. **`croner`** for the schedule expressions — modern, zero-dep, TS-native; the current go-to for
   in-process cron. No new infra.
4. **Cadences in AppSettings** — the tier already exists (`shared/app-settings.ts`). Schedules become
   tunable without a redeploy, env-floor-then-DB-override like the other knobs.

## Two design rules that make it future-proof

1. **Idempotent + restart-safe tasks from day one.** Every task must be harmless to run twice or
   after a crash. This is the unlock: when volume eventually justifies a real queue, you swap the
   **executor** (in-process croner → `@sidequest/sqlite-backend` → BullMQ only if you ever go
   multi-instance) *behind the seam* without rewriting a single task. Same philosophy as the
   `embeddings.model` vector tag — "a swap is a re-index away," not a refactor.
2. **Reserve the interface; don't build the platform (YAGNI).** The table + registry mean the
   platform-or-not decision is later-you's executor swap, not later-you's rewrite.

## The future task surface (so the seam is sized right)

- **DB hygiene** — `PRAGMA optimize` (exists), periodic WAL checkpoint, occasional `ANALYZE`/`VACUUM`.
- **Accumulation pruning** — expired/revoked `sessions`, old `session_entries` (SDK resume cache),
  import temp artifacts. Every login/turn adds rows; unbounded without a prune.
- **Asset GC** — `collectGarbage()` (`domain/assets/service.ts`, mark-sweep for orphaned blobs) on a
  cadence instead of never.
- **Corpus / RAG** — embedding backfill for unindexed content, periodic `reindexAnn` (DiskANN drift),
  full re-index on a model swap, **analytics recompute** (the Track B co-occurrence/theme jobs —
  batch by nature; `docs/breadth-buildout.md`).
- **Caches** — OpenRouter model-catalog refresh (TTL).
- **Someday-multi-user** — per-user quota / rate-limit window resets, scheduled profile backups.

## Current state (2026-05-29) — what exists vs what the seam will absorb

Recorded so the migration is unambiguous when the seam is built:

- **`PRAGMA optimize`** — runs every 3h via a bare `setInterval` (`server/index.ts:96`). → **moves
  into the registry** (+ add a WAL checkpoint task).
- **GPU idle-unload** — a `setInterval` per warm model (`embeddings/warm-model.ts`, ×4: embedder,
  reranker, image-embedder, summarizer). → **STAYS where it is.** This is a *lifecycle eviction*
  coupled to model access (event-driven on use), NOT a clock-driven maintenance job. Don't force it
  into the scheduler just because it's a timer — the seam owns *maintenance cron*, not every timer.
- **Blob GC** — `collectGarbage()` exists but is **unscheduled** (manual-only). → register it.
- **Expired sessions** — `sessions.expiresAt`/`revokedAt` are checked at *read*, never pruned
  (`db/schema/auth.ts`). → register a prune.
- **`session_entries`** — the SDK resume cache grows per turn, no prune. → register a prune.

So the first concrete build is small: move the optimize timer + register GC / session-prune /
entry-prune behind one durable `maintenance` module. ~4 tasks, ~120 lines, on infra we already have.

## When to graduate the executor (the escape hatch)

Stay in-process (croner + the runs table) until a real trigger forces a change. Graduate to a
SQLite-native queue (Sidequest) or beyond **only** when:

- deferred jobs need real **retry/backoff + a dead-letter queue** (e.g. flaky embedding/LLM calls
  that must not block a request), or
- you genuinely run **more than one instance** (then the in-process lock/registry is wrong and you
  need a DB-claimed queue or BullMQ) — note `_shared/lock.ts` already flags this same single-instance
  boundary.

Because tasks are idempotent and table-backed, that graduation is a backend swap behind the seam, not
a product change.

## What NOT to do (slop guard)

- No Inngest / Temporal / Trigger.dev / BullMQ at single-instance scale — wrong shape, wrong infra,
  and (Inngest) not self-hostable. Reconsider only at the multi-instance trigger above.
- No new scattered `setInterval`s in domain code — the registry is the one door.
- No premature scheduler build — this doc is the decision; the code waits for the first real task.

## See also
`docs/architecture.md` (the layer cake) · `docs/data-model.md` (cascade/GC policy) ·
`docs/breadth-buildout.md` (Track B analytics = the deferred-job tenant) · `_shared/lock.ts` (the
single-instance boundary this inherits).
