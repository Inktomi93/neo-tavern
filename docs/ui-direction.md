# UI direction (client UX)

The owner's stance: **core concept first, UI can be "eh" for now** — but build the *skeleton with the
right bones*, not throwaway scaffolding. This is the synthesis of a survey of the three frontend
references (`references/{astra-projecta, marinara-engine, sillytavern}` — all gitignored, so the
conclusions live here). Roles, settled:

- **Marinara-Engine = the architectural twin** (React + Drizzle/libSQL + Agent SDK). Mirror its
  frontend patterns most closely. It independently built **our exact preset model** (reorderable
  sections + markers + a cache `boundary`, versioned config blob, drag-handle editor) — strong
  validation of `shared/prompt-config.ts`. Its `PresetEditor` is the blueprint for our prompt-manager.
- **AstraProjecta = the visual skin + the slicing the owner likes.** Its feature-slicing maps 1:1 to
  ours (and ours is *enforced*, see below). Steal its look: a thin left **icon nav rail** + collapsible
  panel, and a **2:3 portrait character-card grid** (full-bleed avatar, gradient overlay, name+count).
- **SillyTavern = the interaction conventions** a migrating user must not lose. Cut its complexity.

## App shell
Astra's pattern: a thin always-visible **icon nav rail** + a collapsible content panel + the main area.
The key move for *us* — the rail makes the **two co-equal goals first-class**: `Chat | Corpus | Characters`.
The corpus search (`/corpus`, already built) is a peer to chat, not buried. One dark theme, no switcher.

## Chat surface (mirror Marinara)
- Message rows: avatar + name, role styling, **in-house markdown renderer** (both Marinara and Astra
  roll their own — skip heavy remark/MDX; `*italics* = narration` is load-bearing RP convention).
- **Per-chat streaming buffers** in client state (switching chats mid-stream must not lose text) — lands
  with the SSE work (#42).
- Input: multiline auto-resize, Enter sends / Shift+Enter newline.
- A **context-fill meter** off `messages.contextWindow` (sdk reports it accurately; raw needs the
  catalog `contextLength` — the known gap). Opus now reports 200k (we capped the 1M default).

## Per-message actions — the SillyTavern must-haves
A migrating ST user feels the app is *broken* without these five. They also exercise the backend already
built (fork/convert/seed/variants):
1. **Swipes** — inline `← 3/5 →` counter on the message (renders `message_variants`; the 5E write side).
2. **Edit-in-place** — pencil → inline textarea.
3. **Branch/fork** — *`forkChat` already exists*; this is its button.
4. **Markdown + italics** rendering.
5. **Hide-from-AI** toggle (exclude a message from context).

## Character / persona / preset surfaces
- **Library:** Astra's 2:3 portrait grid, virtualized (`@tanstack/react-virtual`) for the 400+ corpus.
- **Editor:** FOCUSED, not ST's 47 fields or Marinara's 13 tabs — name/description/personality/scenario/
  greetings/system-prompt/world-info. (Survey: power-users ignore `mes_example`, sprites, stats, gallery.)
- **Prompt manager (#43):** Marinara's reorderable-sections-with-drag-handles editor, over our
  `PromptConfig` (sections + markers + boundary). The models already match.
- **World Info:** keep our simple `always` vs `keyword` scope. Deliberately NOT ST's recursion / timed
  effects (sticky/cooldown) / AND-NOT logic / depth-weighted insertion (the locked slop-guard stance).

## Component stack (all three converge; we have most)
Tailwind v4 + shadcn/radix ✓ · lucide icons · **sonner** toasts + a **centralized dialog store**
(Marinara's `dialog.store` — port it) · **Zustand** for chat/ui state · in-house markdown ·
**@dnd-kit** for preset reorder · **@tanstack/react-virtual** for long lists. Install per-feature as it
lands (knip flags dead deps) — see `docs/dependencies.md`.

## Slicing — already ours, and ENFORCED
Astra `packages/{ui-kit, core, features/<f>+index, st-surfaces, app/{desktop,mobile}}` ≈ our
`client/{components/ui, lib+state+hooks, features/<f>+index, routes}`. The difference: our three
`dependency-cruiser` rules (`client-feature-front-door`, `client-no-cross-feature`,
`client-foundations-no-features`) make each feature a **sealed box** (Astra's is convention only). We
have no `st-surfaces` analog — we own our UI, we don't wrap ST.

## Future feature: CardRefinery
The owner's `SillyTavern-CardRefinery` (cloned to `references/card-refinery`) — the **Score → Rewrite →
Analyze** pipeline — drops in later as two sealed, additive slices: `client/features/refinery/` +
`server/domain/refinery/`. Zero churn to chat/corpus (feature isolation). The schema already has its
landing spot: `character_versions.refineryScore`/`refineryAnalysis` + copy-on-write versioning ("the
refinery mints versions while preserving history" — `docs/data-model.md`). It's TypeScript +
domain-sliced (`src/domain/{pipeline,character,schema}`), so the **pipeline logic + schema + prompts**
lift cleanly (the answer-key pattern, like the corpus importer). **Caveat (owner): its state layer is a
hand-rolled React + Zustand mess with known state issues — do NOT port that.** Lift the `domain/pipeline`
+ `domain/schema` (the Score/Rewrite/Analyze logic, rubric, prompts) into `server/domain/refinery`, and
**rebuild the state/UI fresh** in our enforced client slice + Zustand patterns. Port the brain, not the wiring.

## Build-first (given "UI eh")
The skeleton with the right bones, not polish: the **nav rail** (`Chat | Corpus | Characters`), a clean
**chat surface**, and the **message-actions + swipe toolbar** — because that's what makes the core
*feel* like ST and renders the backend already built. Card grid, editors, and the preset manager layer
on after the core chat loop feels right.
