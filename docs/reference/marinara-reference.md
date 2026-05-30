# Marinara Engine — reference / answer-key

A map of **Marinara Engine** (`references/marinara-engine`, AGPL-3.0, by Pasta-Devs/SpicyMarinara)
— the closest-stack peer to neo-tavern. Purpose: so we never have to re-explore it. **Read the
*what* and the *patterns*; do NOT paste code** (AGPL + her stack differs). Every row points at a
file so it's a lift-`file:line` answer-key, like `references/README.md` says.

> **The one-line insight:** Marinara is a SillyTavern **preset author** (the "Marinara's Spaghetti
> Recipe" preset). Her engine is **that preset, promoted to first-class architecture** — the ST
> prompt-manager toggle-groups + `{{getvar}}` questionnaire she built by hand became a typed
> *system* (`ChoiceBlock` variables, prompt-overrides, impersonate templates). Origin preset:
> `SpicyMarinara/SillyTavern-Settings → Marinara's Essentials/Preset/Marinara's Spaghetti Recipe.json`.

## At a glance
- **Stack:** pnpm monorepo `packages/{client,server,shared}` · **Fastify + Zod** (server, **REST not
  tRPC** — shared Zod schemas via `@marinara-engine/shared` for typing) · **React 19 + Zustand +
  Vite** (client) · **Drizzle + libSQL** (same DB stack as us).
- **Scale:** ~262k LOC (client 160k · server 96k · shared 10k). Alpha, AGPL-3.0, team/community
  (CoC, 72KB CHANGELOG / 16 releases, Discord, Android build, Home-Assistant add-on).
- **Ethos:** broad, plug-and-play, "fun, agentic, just works." She kept ST's *breadth* (groups,
  themes, image-gen, the provider zoo, an agent/game layer) and re-implemented it. We cut to RP +
  corpus. She's **frontend-maxed** (160k client); we're **backend-maxed** (17k, no client yet).
- **Relationship to ST:** ST-*compatible* + ST-*inspired*, independently engineered (different
  stack ⇒ no code lifted). ST appears only in her **import layer** (`st-chat.importer.ts`,
  `st-prompt.importer.ts`). Same relationship we have with ST.

---

## The steering / POV / preset system (the headline — and what's worth lifting)

This is the cluster that matters most for us. It's layered:

### 1. Preset Variables — `ChoiceBlock` (THE POV mechanism)
`packages/shared/src/types/prompt.ts` (`ChoiceBlock`, `ChoiceOption`) + schema
`packages/server/src/db/schema/prompts.ts`.
- A preset defines **named variables** the user picks *per chat*, injected via `{{variableName}}`:
  `{ variableName: "POV", question: "What POV do you prefer?", options: [{label, value}],
     multiSelect, separator, randomPick }`.
- `{{POV}}` is just ONE instance — a preset author can define any steering axis (tense, tone,
  rating, scenario flavor) as a question + choices surfaced as a picker.
- **`randomPick`** = randomly choose one of the user's selected options *each generation* (instant
  variety). **`multiSelect`** = join several with `separator`.
- This is literally her ST preset's `➀ Omniscient`/`➁ Character's`/`➂ User's` POV toggle-group +
  `{{getvar::perspective}}`, **productized** into a declarative system with real UI.
- **➡ neo-tavern:** this is the highest-value lift. Add `ChoiceBlock`-style **preset variables to
  our `PromptConfig`** (`shared/prompt-config.ts`). It single-handedly answers (a) the macro-audit
  **`variables` gap**, (b) the **`#50` POV / guided-impersonate** mechanism, and (c) a delightful
  authoring surface — onto a cleaner foundation (our typed/versioned/copy-on-write blob vs her
  toggle-prompt hack).

### 2. Prompt variables — `getvar`/`setvar`
`packages/shared/src/types/prompt.ts` (`PromptVariableGroup`, `PromptVariableOption`). The
imperative cousin of ChoiceBlocks — radio-toggle vars referenced via `{{getvar::name}}`. This is her
**stateful variable system** (the macro-audit gap, the imperative half).

### 3. Generation Guide — ephemeral steering (= guided response/swipe)
`packages/shared/src/utils/generation-guide.ts`:
`buildGuidedGenerationInstructionMessage(direction)` → `"[Guided generation instruction — … write
the next generated message steering it toward the following: <direction>]"`;
`stripGenerationGuideInstruction()` removes it after. `GenerationGuideSource = narrator | guide |
game_start`. Consumed in `packages/server/src/routes/generate/generation-replay.ts` +
`generate.routes.ts`; client action `Guide` in `packages/client/src/components/chat/ChatMessage.tsx`.
- **The native equivalent of Guided Generations' QR `/inject ephemeral`** — inject a steering
  instruction, strip it so it never persists as canon.
- **➡ neo-tavern (`#50`):** our spec injects into the **dynamic system-prompt half** instead of
  inline-as-message — *cleaner* (nothing to strip, no strip-regex to miss). Hers is the proven
  reference; ours sidesteps her one fragile bit.

### 4. Impersonate — editable template + direction + POV
`packages/server/src/services/conversation/impersonate-prompt.ts` +
`packages/shared/src/constants/impersonate.ts` (`DEFAULT_IMPERSONATE_PROMPT`, overridable).
Template: *"You are now writing as {{user}}… replicate their voice… Character description:
{{persona_description}}. Additional direction: {{impersonate_direction}}."* Takes
`{customPrompt, direction, personaName, personaDescription}`. Result lands in the **client draft**.
- **➡ neo-tavern (`#50`):** impersonate = generate-as-persona/POV → client draft; editable template +
  `{{impersonate_direction}}`. (We independently want `{{POV}}`; convergence.)

### 5. Scene / encounter POV
`packages/shared/src/types/scene.ts:47` (scene custom system prompt: "writing style, narration POV,
tense, participation style") + `types/combat-encounter.ts:178` (`pov: string`). POV also layers as a
scene/encounter setting. (Game-mode — mostly out of scope for us.)

---

## Chat & generation core

| Feature | Where | neo-tavern mapping |
|---|---|---|
| Messages (row-per-message) | `db/schema/chats.ts` (`messages`: role, content, `activeSwipeIndex`, `extra` JSON) | our `messages` (append-only `seq`) |
| **Swipes** (normalized child table) | `db/schema/chats.ts` (`message_swipes`: messageId, index, content) + `activeSwipeIndex` pointer | our `message_variants` (we both normalized ST's JSON swipe-array — convergence) |
| Branch / fork | client `ChatMessage.tsx` (Branch action) | our `chat.fork` |
| Regenerate / Edit | `routes/generate.routes.ts`, client `ChatMessage.tsx` | our `swipe` / `editMessage` |
| Prompt assembly | `services/prompt/macro-context.ts` (context builder + `{{...}}` substitution — NOT an AST), `services/prompt-overrides/` | our `assemblePrompt` + macro AST engine (ours is a *real* parser; hers is substitution) |
| Lorebooks (world info) | `db/schema/lorebooks.ts`, `services/lorebook/prompt-injector.ts` | our `world-info` domain |
| Streaming | SSE in `routes/generate/*` | our `chatStreamEmitter` → `streamMessages` |
| Multi-device | server-DB-backed (Drizzle) → converge on refresh; no live push | same as us (both lack live push) |
| Concurrency | per-op **patch queues** (`services/storage/chats.storage.ts` `withPatchQueue`) | our `withChatLock` + `expectedSeq` |

## DB / backend patterns (the comparison)
- **Driver/pragmas:** `db/connection.ts` — `@libsql/client`, **identical** boot pragmas (WAL,
  synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON). We add perf pragmas (1GB cache, 2GB mmap,
  temp_store=MEMORY, `PRAGMA optimize`) she doesn't.
- **Transactions:** she uses ~12 `db.transaction()` (works for her — file-DB tests). **We can't**
  (`:memory:` test trap, `docs/architecture/conventions.md`) → we use lock + compensating rollback + append-only.
  Not a gap, a different deliberate trade. (See backlog `#49`.)
- **FK policy:** she's **cascade-only** (17×, 0 restrict / 0 set-null); we use differentiated
  `cascade`/`restrict`/`set null` (DB-enforced safety). We're ahead.
- **Backups:** `routes/backup.routes.ts` — AdmZip of `[storage, avatars, sprites, backgrounds,
  gallery, fonts, knowledge-sources]`; **naive hot file-copy** (no checkpoint/online-backup API). A
  turnkey "export profile" feature we lack; ours delegated to homelab (can be safer if snapshotted).
- **Orphan recovery:** `services/storage/gallery-recovery.ts` `recoverGalleryImages()` (boot,
  `app.ts`) — reconciles disk→DB, recreates rows for orphaned image files. Needed because her
  file+DB writes aren't atomic. Our content-addressed blobs dodge most of this class.
- **Auth (we're clearly ahead):** `.env.example` — **HTTP Basic Auth** (she IS a mini-IdP) + IP
  allowlist + `BYPASS_AUTH_DOCKER`/`BYPASS_AUTH_TAILSCALE` (default ON) + shared `ADMIN_SECRET` +
  global `ENCRYPTION_KEY` (keys encrypted at rest ✓). `middleware/basic-auth.ts`,
  `middleware/security-headers.ts`, `utils/crypto.ts`. We: BFF cookie + OIDC + JWKS forward-auth +
  per-user AES-GCM + revocable sessions, never an IdP.

## The agentic / game layer (mostly OUT of scope for us)
Her "agentic use" pitch. Catalogued for awareness, not for lifting:
- `services/conversation/` — `autonomous.service` + `server-autonomous-scheduler` (AI acts
  on its own / scheduled), `awareness.service`, `auto-summary.service` (memory),
  `character-commands.ts` (LLM creates/edits characters via `create_character`/`update_character`
  tool calls), `selfie-prompt.ts` (in-scene image gen), `schedule.service`.
- `routes/scene.routes.ts` · `game.routes.ts` · `encounter.routes.ts` · `services/game/`
  (`gm-prompts`, `party-prompts`) — game-master mode, parties, combat encounters.
- `routes/generate/agent-normalizers.ts` — `SecretPlotDirection` (hidden GM goals the AI steers
  toward).
- Image-gen / sprites / TTS / connection-manager / quick-reply — ST-breadth she kept, we cut.

---

## What's worth lifting (prioritized)
1. **`ChoiceBlock` preset-variables** → add to our `PromptConfig`. Unifies the macro `variables`
   gap + `#50` POV + a great authoring UX. **Highest value.** Ref `types/prompt.ts`.
2. **Guided-generation pattern** (`#50`) — confirmed native + ephemeral. Ours (dynamic-prompt
   inject) is cleaner than her inline-strip. Ref `utils/generation-guide.ts`.
3. **Impersonate template** (`#50`) — editable template + direction. Ref `constants/impersonate.ts`.
4. **Frontend (when we get there)** — she's our **React-era component/UX answer-key** (same
   React 19 + Zustand + Vite). Copy component/UX patterns, NOT her REST data-fetching (we use tRPC).
   Ref `packages/client/src/components/chat/`.

## What to skip
Agentic/game/encounter layer, image-gen/sprites/TTS, the provider zoo, her auth model, her
substitution-based macro engine (ours is a real AST). Backups: maybe revisit as a "portability"
feature, but our delegated path is fine.

## See also
`docs/planning/parity-audit.md` (the ST-vs-neo audit) · `docs/planning/build-plan.md` `#50` (guided generations) ·
`docs/planning/maintenance-and-scheduling.md` · `references/README.md` (the refs index).
