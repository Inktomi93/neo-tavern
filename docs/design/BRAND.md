# Brand & Voice — Orbweaver

The operational identity layer: the name, the mark, the naming rules, the icon
set, and the **voice** (UX-copy do/don't). Distilled from the Claude Design
handoff's `Brand & Voice.html` into markdown. Pairs with `DESIGN.md` (the *why*)
and `PRODUCT.md` (register/personality). Where this and the prototype disagree,
the prototype's *look* wins and this doc's *rules* win for copy.

> **A private place to weave, search, and refine your stories.**

## The name

The story is real: **Iktomi**, the Lakota spider-trickster, by way of the
`inktomi.tech` handle and the old Inktomi spider/web logo. The product is a
**weaver of stories** — characters and conversations connected as threads in a
web. The name carries that without a footnote.

- **Orbweaver** *(locked working name)* — the spider that spins the classic
  wheel-web, which is literally our logo. Spider-forward, story-rich, ownable;
  reads as a maker, not a toy.
- Alternates considered: **Skein** (a coil of thread — quiet, elegant), **Weft**
  (the thread woven across the loom — short, modern), **Iktomi** (the heritage
  pick — most personal, asks people to learn a word).
- **Avoid plain "Inktomi" as the product name** — it's a defunct company's
  trademark. (The repo/package stays `neo-tavern`; **Orbweaver** is the product
  identity.)

## The mark — spider + web

One geometric **orb-web, monoline, in Ember**. No cartoon spider; the **eight
spokes are the legs**. Three forms cover every use:

| Form | Use |
|---|---|
| **A · The Web** *(primary)* | Abstract, sophisticated. Default mark + in-app glyph. Already throughout the prototype (rail, empty states, loading shimmer) and what the corpus graph literally draws. |
| **B · The Weaver** *(alt)* | A small body at the hub — the spider sitting in its web. More literal. |
| **C · App icon / favicon** | Ember web on the sidebar near-black; simplifies cleanly to 16px. |

Mark **A** is primary; **B** stays as the alt. (Source SVG lives in the handoff
bundle's prototype, not yet committed — re-cut as a `WeaveGlyph` component when the
frontend lands; see `COMPONENTS.md`.)

## Naming — "say what it is"

**The rule:** plain words everywhere someone makes a choice; save the poetry for
the product name and the spider. One quirky label per screen is charm; ten is a
guessing game.

| Where | Was (too cute) | Now (clear) |
|---|---|---|
| Nav | Cast | **Characters** |
| Nav | Chats · Corpus · Refinery · Analytics | *keep — already plain* |
| Theme label | Hearth | **Warm Dark** (nickname "Hearth" as optional subtitle) |
| Theme label | Loom | **Workspace** (the IDE look) |
| Theme label | Pocket | *not a theme — mobile is automatic (responsive)* |
| Theme label | Catppuccin | **Mocha** *keep — it's a known palette* |
| Refinery | Assay | **Scores** |
| Refinery | Score · Rewrite · Analyze | *keep — plain and accurate* |
| Search | "Search the weave…" | **"Search your corpus…"** |
| Graph view | the Weave | *keep — the ONE poetic island* |

**"The Weave" survives in exactly three places:** the **logo**, the
**connection-graph**, and the **empty/loading states**. Everywhere else: say the
plain thing.

## Icons — one set

Standardize on **Lucide** (`lucide-react`, already in the stack). Monoline,
**1.75px stroke, 20px** in the rail. The only custom glyph is the web mark — **no
second icon set**; consistency is the whole point.

| Concept | Icon |
|---|---|
| Chats | `message-circle` |
| Characters | `users` |
| Corpus | `search` |
| Refinery | `filter` / `funnel` |
| Analytics | `bar-chart` |
| Settings | `settings` |
| Send | `send` |
| The mark | *custom — the only one* |

## Voice

**Understated, precise, modern, with a light Iktomi wink reserved for empty and
loading moments.** Calm tool first; cleverness is seasoning, not the meal. (The
CardRefinery "your waifu is trash" energy stays *out* of the product.)

| ✅ Do | ❌ Don't |
|---|---|
| "Stop generation" | "Halt the weave" |
| "No threads match. Try a looser query." | "The web is empty, traveler…" |
| "Run pipeline" · "Refine" · "Save changes" | "Cast the web" · "Re-spin" · "Commit thine edits" |
| "Import your SillyTavern corpus to begin." | "Supercharge your storytelling experience!" |
| empty state, one wink: "Nothing woven here yet." | buzzwords, em dashes, ALL-CAPS sentences, exclamation pile-ups |

**Rules of thumb:**

- **Buttons** = verb + object ("Run pipeline", "Save changes").
- **Errors** = what happened + how to recover.
- **One playful line per screen, max** — and only where stakes are low.
- **No em-dashes in product copy.** (Scoped to UI strings — buttons, labels,
  errors, empty states; prose docs like this one are exempt.)

## Foundation (already locked — see the other docs)

- **Color** — Ember on near-neutral charcoal so the one warm accent reads. Full
  tokens in `src/client/styles/globals.css` (ported from the handoff `theme.css`).
- **Type** — one family: **Geist** (body/display via weight) + **Geist Mono**
  (data, IDs, labels). Self-hosted variable cuts.
- **Personality:** modern · adaptable · understated. **Positioning:** Astra's
  bones, Marinara's soul. **Story:** Iktomi, the weaver of stories. (Full rationale
  in `PRODUCT.md` + `DESIGN.md`.)
