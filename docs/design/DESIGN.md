---
name: "Orbweaver"
description: "Private single-user RP frontend + personal RAG/analytics layer. Astra's restrained bones, a little Marinara soul, an Iktomi weave running underneath. Modern, adaptable, understated."
register: product
seed: true   # pre-implementation seed; re-derive real tokens once code lands
strategy: "Restrained — tinted-neutral charcoal ramp + ONE signature accent (ember). Distinct from Marinara pink and Astra blue."
typography:
  family: "Geist"          # one family carries display/body/label via weight
  mono: "Geist Mono"        # code, data, IDs, and the Work-mode label voice
  notes: "Product register: one well-tuned family beats a pairing. Geist is modern, free, not an overused tell (Inter/Roboto/Arial), and is the Astra link."
radius:
  base: "0.5rem"   # 8px
  control: "0.375rem"  # 6px controls
  card: "0.625rem"     # 10px panels
  full: "9999px"       # pills, avatars
spacing_unit: "0.25rem"  # 4px scale (Astra-aligned)
motion:
  fast: "140ms ease-out"
  base: "200ms ease-out"
  expressive: "320ms cubic-bezier(0.16, 1, 0.3, 1)"  # signature moments only
  rule: "Conveys state, not decoration. 150–250ms default. No page-load theater. Always a prefers-reduced-motion fallback."
---

# Design System: Neo-Tavern (seed)

## 1. North star

**"A quiet room that changes with the light."** One coherent tool that wears
three faces — Home, Pocket, Work — from a single token system. Restrained and
modern on the surface; an Iktomi thread of warmth and cleverness underneath.
Astra's structural discipline carries the app; Marinara's soul shows up as a
single warm accent, atmosphere in empty states, and a few deliberate moments.

## 2. The signature: the Weave (Iktomi)

Iktomi, the Lakota spider-trickster, and the old Inktomi spider/web mark →
a **weaver-of-stories** metaphor. For an RP tool whose RAG layer literally
connects characters, scenes, and conversations, threads and webs are *meaningful*
structure, not ornament.

- **Mark:** a minimal geometric spider/web glyph — a few radial threads meeting at
  a node. Monochrome, scalable to a 16px favicon. Never a cartoon spider.
- **Where it appears (sparingly):** empty states (a faint web filigree),
  loading/skeleton (a spider-silk shimmer sweeping the threads), and the
  corpus/RAG view (entity connections rendered *as* a literal thread-web).
- **Restraint rule:** at most one Weave moment per screen. In Work mode it shrinks
  to a single mono glyph. The web is felt, not announced.

## 3. Color

**Strategy: Restrained.** Tinted-neutral ramp + one accent ≤ ~10% of surface.
Authored in **OKLCH** (Tailwind v4 native). The accent is **Ember** — a warm amber
that ties the old Inktomi orange, tavern-hearth warmth, and Marinara's soul into
one signature, deliberately avoiding both Marinara pink and Astra blue.

Tokens map 1:1 onto the **shadcn contract** (so every Radix/shadcn component is
on-brand for free) and are declared in Tailwind v4 `@theme`.

### Hearth — Home mode (dark, default)

```
--background        oklch(0.175 0.012 65)   /* warm charcoal */
--foreground        oklch(0.95 0.006 75)    /* warm off-white */
--card              oklch(0.205 0.012 65)
--card-foreground   oklch(0.95 0.006 75)
--popover           oklch(0.235 0.013 65)
--popover-foreground oklch(0.96 0.006 75)
--primary           oklch(0.76 0.145 66)    /* Ember */
--primary-foreground oklch(0.18 0.02 65)
--secondary         oklch(0.255 0.014 65)
--secondary-foreground oklch(0.95 0.006 75)
--muted             oklch(0.255 0.012 65)
--muted-foreground  oklch(0.71 0.013 68)    /* AA on --background */
--accent            oklch(0.285 0.02 65)    /* hover/selected surface */
--accent-foreground oklch(0.96 0.006 75)
--destructive       oklch(0.62 0.19 25)
--destructive-foreground oklch(0.97 0.01 25)
--border            oklch(0.97 0.01 75 / 0.09)
--input             oklch(0.97 0.01 75 / 0.13)
--ring              oklch(0.76 0.145 66)    /* Ember focus */
--sidebar           oklch(0.15 0.011 65)    /* deeper than content */
--sidebar-foreground oklch(0.92 0.006 75)
--sidebar-primary   oklch(0.76 0.145 66)
--sidebar-accent    oklch(0.235 0.014 65)
--sidebar-border    oklch(0.97 0.01 75 / 0.08)
/* analytics — anchored on Ember, restrained spread for recharts */
--chart-1 oklch(0.76 0.145 66)   /* ember */
--chart-2 oklch(0.70 0.10 200)   /* muted teal */
--chart-3 oklch(0.68 0.12 300)   /* dusty violet */
--chart-4 oklch(0.74 0.11 130)   /* sage */
--chart-5 oklch(0.70 0.12 35)    /* clay */
```

### Loom — Work mode (cool, IDE-camouflage)

Reads as a developer tool (VS-Code-adjacent, *not* a clone). Warmth dialed almost
out: cooler near-black slate, near-monochrome, Ember muted to a single quiet
focus/active cue. Denser. Mono used more (labels, gutters). Same token *names*,
cooler values:

```
--background  oklch(0.165 0.004 250)   /* cool slate near-black */
--foreground  oklch(0.90 0.004 250)
--sidebar     oklch(0.145 0.004 250)   /* "activity bar" */
--primary     oklch(0.70 0.085 235)    /* quiet steel-blue accent */
--ring        oklch(0.70 0.085 235)
--muted-foreground oklch(0.66 0.006 250)
/* …rest follow the cool ramp; Ember survives only as a tiny brand glyph */
```

### Pocket — Mobile mode

Same **Hearth** palette (no recolor); the change is *structural*, per the product
register: bottom tab bar, ≥44px hit targets, larger body, single-column, drawers
instead of side panels. Mode = layout + density, not a different look.

> A **Light** theme is deferred (use-scene is dark-leaning) but the token
> structure supports it; add a `:root` light block when needed.

## 4. Typography

One family, two cuts. Fixed rem scale (product register — not fluid/clamp).
Hierarchy via scale + weight, ratio ~1.2.

| Role | Font / size / weight |
|------|----------------------|
| Display (page/modal titles) | Geist 600, 1.5rem / 1.25 |
| Headline (section) | Geist 600, 1.25rem / 1.3 |
| Title (card, message author) | Geist 600, 1rem / 1.35 |
| Body (chat, prose) | Geist 400, 0.9375rem / 1.55, cap 65–75ch |
| Label (buttons, chips, tabs) | Geist 500, 0.8125rem / 1.25 |
| Mono (code, IDs, data, Work labels) | Geist Mono 400, 0.8125rem |

## 5. Elevation & surface

Flat by default (Astra discipline). Lift only for popovers/modals/dragging.
Marinara's *glow* is rationed to one place: a soft Ember focus/character glow,
e.g. `0 0 0 1px oklch(0.76 0.145 66 / .4), 0 0 14px oklch(0.76 0.145 66 / .18)`
on the active conversation or a focused character — never behind long text.
No glassmorphism as default; no side-stripe borders; no gradient text.

## 6. Components (theme, don't rebuild)

Radix + shadcn own behavior; we own tokens + a few signature touches. Every
interactive component ships **all states** (default/hover/focus/active/disabled/
loading/error). Loading = skeletons (with the silk shimmer), not center spinners.
Empty states teach and carry the Weave. Satellite libs bridged to tokens:
recharts → `--chart-*`; CodeMirror → one token-mapped editor theme; sonner →
`--popover`/`--border`; scrollbars + resize handles → the neutral ramp.

## 7. Motion

CSS + `tw-animate-css` for Radix enter/exit. Scope a real motion lib (`motion`)
to signature moments only: message arrival (fade + 4px rise), mode transition
(token cross-fade), and the Weave silk shimmer. 140–200ms for state; the 320ms
expressive curve only for those moments. Every one has a reduced-motion fallback.

## 9. Component states & motion (baked in)

Per impeccable's `interaction-design` + `animate`, standardized once so every
shadcn/Radix component inherits them:

**The 8 states** — every interactive element defines all of: default · hover ·
**focus-visible** (keyboard ring = `--ring`, 2px, offset 2px; never bare
`outline:none`) · active · disabled · loading (skeleton, not center spinner) ·
error (`--destructive` + icon + message) · success (`--success` + check). Undo
(sonner toast) beats confirm dialogs for delete / Refinery reset / revert.

**Motion tokens** (the 100/300/500 rule, `--ease-out-expo`, exit ≈75% of enter,
all with `prefers-reduced-motion` fallbacks):
```
--motion-fast: 130ms     /* press, toggle, color */
--motion-base: 220ms     /* menu, tooltip, hover, theme cross-fade */
--motion-layout: 360ms   /* accordion, drawer, stage transition */
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);   /* no bounce, no elastic */
```
Budget spent only on: message arrival (fade + 4px rise, stagger ≤500ms total),
theme/mode cross-fade (our "transforms with the light"), Refinery stage change +
silk shimmer, and streaming text. Perceived performance (optimistic send,
skeletons, stream-early) matters more than raw speed for an LLM app.

## 8. Open decisions (for the visual exploration)

- **Ember exactly right?** I'll show 2–3 accent candidates (ember / clay-rose /
  spider-silk teal) against the Hearth base so you can feel them in context.
- **How far Loom leans into VS-Code** (subtle dev-tool vs. strong activity-bar).
- **Weave intensity** — whisper vs. a touch more present.
- **Name** — locked: **Orbweaver** (the orb-weaver spider that spins the wheel-web; see Brand & Voice).
