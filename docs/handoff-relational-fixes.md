# Handoff — relational integrity + preset versioning migration

> **MIGRATION NUMBER — read this:** originally specced as "0005", but later migrations
> claimed lower numbers (0005 = `embeddings.hub_score`/CSLS, 0006 = `embeddings.source_text`/
> reranker). This migration takes **the next available number when it actually lands** —
> currently **0007** (`ls src/db/migrations/` to confirm). Do NOT hardcode a number; this
> filename is intentionally number-agnostic so it stops churning. Everything below is
> number-relative ("additive — don't rewrite earlier migrations").

**For the implementing agent. You do NOT have the design conversation that produced this — everything you need is here. Read `docs/data-model.md` (esp. lines 227–330) and `docs/architecture.md` (the `db` layer rule) before starting.**

This is a **schema + migration + doc + tests** task. It is NOT a feature task — do not build preset domain services, tRPC routers, or UI (separate later work).

---

## ⚠️ WARNING — two real bugs in the current schema

### 1. There is almost no referential integrity (the urgent one)
Of 19 tables, **only 7 foreign keys exist — every one is `owner_id → users.id`, all `ON DELETE no action`.** No *internal* relationship is a real FK: `messages.chatId`, `message_variants.messageId`, `session_entries.chatId`, the world-info junctions, `character_versions.characterId`, `chats.characterVersionId` are all plain `text` columns the DB does not enforce.

**Consequence:** "nuke the chat" is a core YGWYG operation, and `DELETE FROM chats WHERE id = ?` today **orphans** every message, variant, session_entry, and junction row — there is no cascade. The DB already holds **20,845 imported messages** with zero enforced integrity between any rows; a write with a bad `chatId` is not caught.

### 2. Preset provenance points at a mutable row (the subtle one)
`messages.presetId` records *which preset generated this message* — but `presets` is a **mutable** row (`updatedAt`, edit-in-place). Editing a preset therefore **silently rewrites the recorded generation provenance of every past message** that used it. This is exactly the failure `character_versions` was built to prevent ("editing a character never rewrites past canon"). Because **analytics over the corpus is the product**, this breaks the queries we actually want (e.g. "messages from preset X v2 vs v3").

---

## ✅ WHAT WE WANT

### A. Content-version presets, mirroring characters (copy-on-write)
> **This REVERSES a previously-locked decision.** `data-model.md:318–329` currently classifies presets as type-2 (blob-*shape* versioning only) and says "don't version everything." The owner has approved moving presets to **type-3 (content/canon versioning)**, identical to characters. **Update the doc to match — do not preserve the old policy.** (CLAUDE.md says "raise a question if you disagree with a locked decision"; that has happened and this is the resolution.)

Replace the single mutable `presets` table with the identity/version/pin triad already used for characters:

```
presets         (id, ownerId→users.id, name, kind, currentVersionId→preset_versions.id, createdAt, updatedAt)
preset_versions (id, presetId→presets.id, version, config{json}, schemaVersion{int default 1}, createdAt)
                 UNIQUE(presetId, version)
```
- `config` (the whole bundle) and `schemaVersion` (the type-2 blob-shape version, kept for migrate-fns) **move onto `preset_versions`**. The identity row holds no config.
- **Copy-on-write increment policy — identical to characters** (see `src/server/domain/import/service.ts` for the reference implementation): editing a version **no chat/message pins** mutates it in place; editing a **pinned** version forks `version = max+1` and repoints `currentVersionId`. The reference pattern for the circular `currentVersionId` insert order is already in the importer — reuse it.

### B. Preset ↔ chat binding: MONOLITHIC, one preset-version per chat (NOT a typed junction)
- `chats.presetId` → rename to **`chats.presetVersionId` → preset_versions.id** (the chat's default config for its next turn).
- `messages.presetId` → rename to **`messages.presetVersionId` → preset_versions.id** (immutable provenance: which preset version was the basis for this message).
- `presets.kind` stays as a **descriptive library label** (notNull, free text) — it is NOT a structural type.
- **DO NOT build a `chat_preset_versions(chatId, kind, presetVersionId)` junction.** Rationale: single user; sdk-mode (the default/present) barely exposes a preset surface; per-turn model/reasoning are message columns (see C), which already covers independent per-turn variation. The junction earns its keep only in raw-mode (Phase 5) if recombining a fixed sampling profile under different system scaffolds becomes a real need. It is a cheap additive migration *then* (presets table is empty now), so deferring costs nothing.

### C. Per-message generation params are MESSAGE COLUMNS, not presets
Model/reasoning vary per turn — that is **provenance**, recorded on the message, not a preset. `messages` already has `model`, `provider`, `stopReason`, tokens, cache tokens, `costUsd`. **Add:**
- `messages.reasoningEffort` (text, nullable)  — e.g. `"low"|"medium"|"high"` or a budget string
- `message_variants.reasoningEffort` (text, nullable) — each swipe can differ
- *(optional)* `messages.genParams` (json, nullable) for long-tail resolved knobs not worth a column. Keep `model`/`reasoningEffort` as **columns** (they are primary analytics GROUP BY axes), not buried in json.

### D. Declare every enforceable FK with this cascade policy

| Child column | → Parent | Null? | ON DELETE | Why |
|---|---|---|---|---|
| `character_versions.characterId` | characters.id | no | **CASCADE** | versions die with the character |
| `characters.currentVersionId` | character_versions.id | yes | **SET NULL** | circular pointer only |
| `chats.characterVersionId` | character_versions.id | no | **RESTRICT** | can't delete a pinned version — archive instead |
| `chats.personaId` | personas.id | yes | **SET NULL** | optional ref |
| `chats.presetVersionId` | preset_versions.id | yes | **RESTRICT** | preserve provenance |
| `chats.parentChatId` | chats.id (self) | yes | **SET NULL** | fork link survives parent deletion |
| `messages.chatId` | chats.id | no | **CASCADE** | "nuke the chat" cleans up |
| `messages.parentId` | messages.id (self) | yes | **SET NULL** | reserved branching field |
| `messages.presetVersionId` | preset_versions.id | yes | **RESTRICT** | provenance |
| `message_variants.messageId` | messages.id | no | **CASCADE** | swipes die with the message |
| `world_entries.worldBookId` | world_books.id | no | **CASCADE** | |
| `chat_world_entries.chatId` | chats.id | no | **CASCADE** | junction |
| `chat_world_entries.entryId` | world_entries.id | no | **CASCADE** | junction |
| `cv_world_entries.cvId` | character_versions.id | no | **CASCADE** | junction |
| `cv_world_entries.entryId` | world_entries.id | no | **CASCADE** | junction |
| `session_entries.chatId` | chats.id | no | **CASCADE** | resume cache |
| `preset_versions.presetId` | presets.id | no | **CASCADE** | versions die with preset |
| `presets.currentVersionId` | preset_versions.id | yes | **SET NULL** | circular pointer only |
| `taggables.tagId` | tags.id | no | **CASCADE** | |
| existing `*.ownerId` | users.id | no | leave as-is | no-op single-user |

**Genuinely cannot FK (polymorphic — leave alone, document why):** `embeddings.(entityType, entityId)`, `taggables.(entityType, entityId)`.

**Intended interaction (do NOT "fix" it):** deleting a character/preset that has chats is *blocked* — CASCADE to its versions hits the RESTRICT from `chats.*VersionId`, so the whole delete fails atomically. That is correct: **archive, don't delete** provenance-bearing entities. (`characters`/`chats` already have an `archived` flag; presets may get one later — out of scope here.)

---

## 🧠 HEADS-UP — SQLite/drizzle landmines

1. **SQLite cannot `ALTER TABLE ADD CONSTRAINT`.** Adding FKs to existing tables requires the full **table-recreate** (create new w/ FKs → `INSERT…SELECT` → drop old → rename). `drizzle-kit generate` emits this when you add `.references(...)`, wrapped in `PRAGMA foreign_keys=OFF … =ON`. **Most tables are POPULATED** (20,845 msgs, 801 chats, etc.) — the recreate copies real data. Verify row counts before/after.
2. **After migrating, run `PRAGMA foreign_key_check`** on the real imported DB to confirm the existing data satisfies the new FKs. The importer reports "zero dangling refs" — verify, don't trust. If anything dangles, clean it before the FKs will hold.
3. **Circular FKs** (`characters.currentVersionId ↔ character_versions`; `presets.currentVersionId ↔ preset_versions`): insert order = parent row with `currentVersionId` NULL → insert version → `UPDATE` parent's `currentVersionId`. No `DEFERRABLE` needed. The importer already does this for characters — mirror it for presets.
4. **Hand-written SQL must survive.** Migration `0001` hand-adds the `libsql_vector_idx` ANN index (drizzle-kit can't emit it). **This migration is additive — do not regenerate/rewrite any earlier ones.** Hand-read the generated SQL before applying; drizzle's SQLite differ sometimes recreates more than intended — confirm it does not drop the `message_variants`/import columns (0002/0003), the `embeddings.hub_score` (0005) / `source_text` (0006) columns, or the vector column/index (0001).
5. `foreign_keys = ON` is already set per-connection in `src/db/client.ts` (confirmed). The migration recreate toggles it internally; make sure `runMigrations` path handles that.
6. **Conventions:** `db` layer imports only `shared` + externals (dependency-cruiser enforces). Column names are explicit `snake_case` (no drizzle casing inference). Match the existing style in `schema.ts`.
7. `chats.presetId` / `messages.presetId` are **all-null and unreferenced by any code** (verified) — the rename to `presetVersionId` is safe and needs no data backfill.

---

## 📋 ACCEPTANCE CRITERIA

- [ ] `pnpm check` green (biome + tsc + `pnpm arch` + vitest) — pre-commit hook enforces.
- [ ] Test (extend `tests/integration/db-foundation.test.ts`): deleting a chat **cascades** to its messages, message_variants, session_entries, chat_world_entries — zero orphans remain.
- [ ] Test: deleting a `character_version` or `preset_version` that a chat pins is **rejected** (RESTRICT).
- [ ] Test: preset **copy-on-write** — editing an unpinned version mutates in place; editing a pinned version forks `version = max+1` and repoints `currentVersionId` (mirror the character-version test if one exists).
- [ ] `PRAGMA foreign_key_check` returns empty on the real imported DB after `pnpm import:st` + migration.
- [ ] `pnpm import:st` is still **idempotent** (re-run → identical counts, no dupes). Importer needs no preset changes (it never set `presetId`); just confirm new nullable columns don't break it.
- [ ] `docs/data-model.md` updated: move presets to **type-3** in the versioning section (318–329); add a short **FK-declaration / cascade policy** subsection (there is none today); update the presets/settings rows in the schema listing. Keep the `schema.ts` header comment accurate.

---

## 🚫 OUT OF SCOPE — do not do these
- ❌ No typed-preset junction (`chat_preset_versions`). Monolithic binding only.
- ❌ No preset domain service / tRPC router / UI. Schema + migration + doc + tests only.
- ❌ Do NOT touch `settings` or `user_settings` — they are correct (per-user versioned blob + global k/v). Adding structure there is slop.
- ❌ Do NOT add FKs to polymorphic columns (`embeddings`, `taggables` entity refs).
- ❌ Do NOT give `assets` an `ownerId` — global + content-addressed by design.
- ❌ Do NOT weaken the RESTRICT rules to make deletes "just work" — archive-not-delete is intended.

## Pointers
- `docs/data-model.md` — the spec (UPDATE it). Design notes 227–330; versioning policy 318–329.
- `docs/architecture.md` — `db` layer rule.
- `src/db/schema.ts` — schema. `src/db/migrations/` — add the next sequential migration (`ls` to find it; 0007 at time of writing). `src/db/client.ts` — PRAGMAs + `runMigrations`.
- `src/server/domain/import/service.ts` — the **copy-on-write + circular-currentVersionId reference implementation** to mirror for presets.
- `scripts/import-st.ts` + `src/server/domain/import/` — importer; keep idempotent.
- `tests/integration/db-foundation.test.ts` — FK smoke test to extend.
