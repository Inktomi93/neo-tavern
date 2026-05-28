# UI direction (client UX)

The owner's stance: **core concept first, UI can be "eh" for now** — but build the *skeleton with the
right bones*, not throwaway scaffolding. This is the synthesis of a survey of the three frontend
references (`references/{astra-projecta, marinara-engine, sillytavern}` — all gitignored, so the
conclusions live here). Roles, settled:

- **Marinara-Engine:** It used the right tools (`Zustand` + `React Query`), but its execution became a monolithic **DOM hell** (e.g., massive 2,200-line components like `ChatArea.tsx` and an 80KB global `ui.store.ts`). We will steal its toolset but strictly avoid its bloated god-components and massive global stores.
- **AstraProjecta:** It got feature-slicing right (`packages/features`), but it made two fatal architectural mistakes: (1) splitting the app into separate `app/desktop` and `app/mobile` deployments, and (2) using a weird hybrid of Vanilla JS DOM injection wrapped around React islands. We will steal its look and feature-isolation, but stay 100% React and use a single unified deployment.
- **SillyTavern:** The interaction conventions a migrating user must not lose. Cut its complexity and eliminate its jQuery DOM hell.

## Architectural Rigor & Enforcements
To guarantee our frontend doesn't become a nightmare of tangled state:
1. **No God-Components:** `biome.jsonc` enforces `noExcessiveCognitiveComplexity` as a hard error. If a component gets too large or complex, the build fails.
2. **Feature Isolation:** `dependency-cruiser` strictly enforces that features in `client/features/` are sealed boxes that cannot import each other's internals.
3. **Localized State:** Zustand stores must be localized per feature (e.g., `features/chat/store.ts`), NEVER dumped into a massive global `ui.store.ts` unless the state is genuinely global (like the active theme).

## App shell (Single-Deploy Responsive)
Unlike Astra, we will use a **Single Unified App Shell** powered by Tailwind v4 breakpoints.
- **Desktop:** A thin always-visible **icon nav rail** (`Chat | Corpus | Characters`) + a collapsible content panel.
- **Mobile:** The exact same nav rail snaps to the **bottom tab bar** via `md:hidden`, giving a native app feel from the exact same codebase.
The corpus search (`/corpus`) is a peer to chat, not buried. One dark theme, no switcher.

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

### The Concrete Client Folder Structure
Based on our reference analysis, here is exactly how `src/client/` is organized:
```text
src/client/
├── components/          # Generic foundations (dumb UI)
│   └── ui/              # shadcn/ui primitives (Button, Dialog)
├── features/            # Sealed business logic boxes
│   ├── chat/            # The chat interface
│   │   ├── components/  # Chat-specific UI (MessageBubble)
│   │   ├── store.ts     # Feature-local Zustand state
│   │   └── index.ts     # The ONLY allowed export surface
│   ├── prompt-manager/  # The Preset editor
│   ├── character/       # Card library
│   └── corpus-search/   # RAG analysis
├── routes/              # TanStack routing & AppShell layout
├── lib/                 # Core utils (trpc, cn)
└── hooks/               # Generic React hooks
```

## Backend-Heavy, Frontend-Light Philosophy
SillyTavern became a sluggish "DOM Hell" because it forced the browser to do backend work (JS-based `tiktoken` counting, `fuse.js` fuzzy searches, `localforage` offline databases, and `@jimp` image processing). 
We reject that model. `neo-tavern` is **impossibly fast** because:
- **Tokenization:** Handled natively in Rust (`@anush008/tokenizers`) on the `hono` backend.
- **Semantic Search:** Handled by in-process GPU vector searches (`libSQL`) on the backend.
- **Data Persistence:** Handled securely by SQLite; the client is completely stateless via TanStack Query.
The React frontend exists *purely* to render state quickly and beautifully using Astra's Radix UI models.

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
