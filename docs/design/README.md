# Design system — Orbweaver (the visual answer-key)

The product's visual identity + design-system reference, from a **Claude Design**
handoff (claude.ai/design). Like `docs/reference/marinara-reference.md`, this is a
**read-don't-paste** answer-key: the design medium was HTML/CSS/JS prototypes; we
recreate the *look* in our stack (React 19 + Tailwind v4 + shadcn), we do not port
the prototype markup.

> **Name:** the product identity is **Orbweaver** (the repo/package stays
> `neo-tavern`). The story: *Iktomi* — the Lakota spider-trickster + the old
> Inktomi spider/web mark → a **weaver-of-stories** metaphor for an RP tool whose
> RAG layer connects characters and conversations as threads in a web.

## What landed in the code (source of truth)

- **Tokens → `src/client/styles/globals.css`.** The handoff's `theme.css` is ported
  there as the live Tailwind v4 `@theme` contract: three dark faces via
  `[data-theme]` — **Hearth** (Warm Dark, default) / **Catppuccin** (Mocha, OLED) /
  **Loom** (Workspace, IDE-camouflage) — Ember accent, the full shadcn token set +
  `success/warning/info/sidebar/chart-*/speaker/narration`, motion vars, the
  `shadow-glow` utility, the `:focus-visible` ring, and `prefers-reduced-motion`.
  **`globals.css` is the source of truth for token *values*** — the `DESIGN.md`
  color block below is the earlier *seed* and may show pre-refinement OKLCH values;
  trust the CSS.
- **Fonts → self-hosted, variable.** `@fontsource-variable/geist` +
  `@fontsource-variable/geist-mono`, `@import`ed at the top of `globals.css`
  (offline-safe; no runtime CDN — fits the SSRF-egress posture). The fontsource
  families register as **"Geist Variable" / "Geist Mono Variable"** (note the
  suffix — that's why the `--font-sans/--font-mono` stacks lead with those names).
- **`tw-animate-css`** is installed for Radix enter/exit utilities (the design's
  motion layer).

## The docs here (rationale, not yet code)

- **`DESIGN.md`** — the design system: north star, the Weave motif, color strategy
  (OKLCH, Ember), typography, elevation, motion, the 8 component states. The *why*.
- **`PRODUCT.md`** — register, user, brand personality, anti-references, principles
  ("Astra's bones, Marinara's soul"; "theme is a feature, not a setting").
- **`COMPONENTS.md`** — the component inventory: stock shadcn to generate as-is +
  the custom product pieces (NavRail, ManuscriptThread, Composer, CommandPalette,
  Refinery, ConnGraph, EmptyState, WeaveGlyph). The build list for the frontend.
- **`BRAND.md`** — the operational identity: the name (Orbweaver), the mark, the
  "say what it is" naming table, the Lucide icon map, and the **voice** (UX-copy
  do/don't + rules). The doc to reach for when writing any button/label/empty state.

## Not in the repo (reference-only, in the handoff bundle)

The HTML/JSX prototypes (`Neo-Tavern.html`, `nt-app.jsx`, `nt-ui.jsx`, `shell.jsx`,
`Brand & Voice.html`, the spider-web favicon mark) and the bundled astra/marinara
CSS were **not** copied in — they're visual targets to mine when building the
client features, not code to paste. They map onto the existing client plan in
[`docs/planning/ui-direction.md`](../planning/ui-direction.md) (NavRail, Manuscript
reading view, the three-mode shell) — build against that, using these as the look.

## Status

Foundation only. The token + font contract is live so every shadcn/Radix component
themes on-brand for free once the frontend lands. The components in `COMPONENTS.md`
are **not built** — the client is still scaffolding (see `docs/planning/build-plan.md`).
