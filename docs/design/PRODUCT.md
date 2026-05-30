# Product

## Register

product

## Users

A single user: the developer-owner. A strong engineer, self-described weak
product designer, who wants a tool that looks and feels excellent without
fighting for it. This is a **private, single-user** application — not a
multi-tenant SaaS, not a shared community product. Design decisions optimize for
one person's daily, long-term use, not for onboarding strangers or marketing.

The user's context shifts, and the product must follow:
- **At home:** long, focused, often-evening roleplay and reading sessions. Wants
  warmth and atmosphere; comfort over density.
- **On a phone:** quick sessions, one-handed, on the go. Touch-first, reachable.
- **At work:** needs the UI to *blend in* — to read like a developer tool (a
  VS-Code-adjacent look, similar not identical) so it's discreet and unremarkable
  on a work screen, while staying fully usable.

## Product Purpose

A private roleplay / chat frontend layered over the user's own RP corpus, plus a
personal RAG and analytics layer for searching, exploring, and understanding that
corpus. It runs immersive RP and conversation sessions and turns a large personal
archive into something queryable and legible.

Success: a tool the owner trusts and enjoys living in for years — beautiful,
fast, and quietly capable — that reshapes itself to wherever it's being used
without ever feeling like three different apps.

## Brand Personality

**Modern · adaptable · understated.** Beautiful, but never showy. The product
should feel current and considered, get out of its own way, and let its quality
show through coherence and restraint rather than ornament. Underneath the calm
surface runs a thread of **Iktomi** — the spider-trickster, the weaver: clever,
quietly playful, a maker of connections. Identity is a whisper, not a logo splash.

## Anti-references

- **A bland SillyTavern clone with no identity of its own.** Familiar structure is
  fine; copying structure without a point of view is not.
- **A sterile SaaS dashboard** — gray card grids, enterprise emptiness, dry labels.
- **Anything cute, toy-like, or over-decorated.** No mascots-as-UI, no novelty for
  its own sake, no childishness.
- (Inherited from the north stars) not a generic Discord clone.

## Design Principles

1. **Astra's bones, Marinara's soul.** A restrained, professional structure carries
   the app; warmth and atmosphere appear as a signature accent and in deliberate
   moments — never as background decoration.
2. **Theme is a feature, not a setting.** The interface transforms by context —
   Home, Mobile, Work-camouflage — from one coherent token system. Adaptability
   and interchangeability are core product value, designed in from the start.
3. **Disappear into the task.** Judged like Linear or Raycast: trusted instantly,
   invisible during long sessions. Legibility and flow beat flourish every time.
4. **Quiet identity.** The brand shows through palette, type, and one subtle
   signature motif (the Iktomi weave — stories and connections as threads), never
   through loudness or cuteness.
5. **Build with the grain.** Lean on Radix / shadcn / Tailwind v4 / TanStack for
   primitives and structure; spend our craft on tokens, type, spacing, motion, and
   a few signature moments — not on reinventing components.

## Accessibility & Inclusion

Single-user, but the bar stays high because the user lives here daily:
- **Long-session readability is the floor.** Body text meets WCAG AA (≥4.5:1) in
  every mode; no light-gray-for-elegance on tinted surfaces.
- **State is never color alone** — pair with icon, shape, or text, so modes (incl.
  any future high-contrast or color-blind-safe theme) stay legible.
- **Reduced motion respected** — every animation has a `prefers-reduced-motion`
  fallback. Motion conveys state; it is never required to understand the UI.
