# Neo-Tavern component inventory

What to build on (don't reinvent), our variants, and the custom pieces unique to
the product. Pairs with `theme.css`. Convention: shadcn-style — `cva` for
variants, `cn()` (clsx + tailwind-merge), `lucide-react` icons, Radix behavior.

## Theme switching (the core mechanic)

Themes are `[data-theme]` on `<html>`; default (no attribute) = Hearth. Persist
in zustand and reflect to the DOM:

```ts
// store
type Theme = 'hearth' | 'catppuccin' | 'loom'; // + 'latte' (light) later
const useTheme = create<{theme: Theme; setTheme: (t: Theme) => void}>()(
  persist((set) => ({
    theme: 'hearth',
    setTheme: (theme) => { document.documentElement.dataset.theme = theme; set({ theme }); },
  }), { name: 'nt-theme' })
);
// on hydrate: document.documentElement.dataset.theme = useTheme.getState().theme;
```

Cross-fade on switch (motion `--motion-base`, reduced-motion safe). Hearth as
default means SSR/first paint with no attribute is already correct.

## Stock shadcn/ui to generate as-is (theme via tokens only)

Button · Input · Textarea · Label · Select · Checkbox · Switch · Slider ·
Tabs · Tooltip · Popover · DropdownMenu · Dialog · Sheet (drawer) · Command (⌘K) ·
Badge · Separator · ScrollArea · Skeleton · Sonner (toast) · Resizable
(react-resizable-panels) · Avatar · Card (use sparingly — not the default answer).

These already consume `--background`/`--primary`/`--ring`/etc., so they inherit
all four themes for free. **All ship the 8 states** (default/hover/focus-visible/
active/disabled/loading/error/success) — don't ship half.

## Our variant notes

- **Button** (`cva`): `primary` (Ember solid) · `secondary` (muted surface) ·
  `ghost` (icon actions) · `destructive`. Sizes `sm 32 / base 36 / lg 40`.
  Icon-only buttons are circular. Loading = inline spinner + disabled.
- **Badge / verdict chip**: `neutral` · `success` · `warning` · `info` ·
  `destructive`, each a tint of its semantic token + a leading dot/icon (never
  color alone). Used by Refinery verdicts and status.
- **Input/Textarea**: token border, `:focus-within` ring; error variant uses
  `--destructive` + message below via `aria-describedby` (validate on blur).
- **Avatar**: initials fallback now (placeholder for real card art); circular.

## Custom components (the product's own — build these)

| Component | Notes |
|---|---|
| **WeaveGlyph** | The mark: geometric spider/web node. Sizes 12→84. `anim` prop drives the silk shimmer (reduced-motion → static). Logo, empty states, loading. |
| **NavRail** | 56px icon column; brand glyph top, active item = `--primary` + tint; settings + avatar bottom. Roving tabindex. |
| **ManuscriptThread** | Direction-2 reading view. `Turn` (speaker label in `--speaker` mono-caps + flowing `--prose`), `Narration` (centered muted italic), `you` modifier (indented, quieter). No bubbles. Streaming-aware (append tokens). |
| **Composer** | Pill input + send (Ember) + attach. Optimistic send; disabled while generating; **Stop** button mid-stream. |
| **CommandPalette** | ⌘K — jump to threads/characters/corpus. Built on shadcn Command. |
| **Refinery** | Feature surface. Sub-parts: `StageStepper` (Score→Rewrite→Analyze + iterate, roving tabindex), `Assay` (score bars filled with `--primary` + verdict chip), `IssueList`, `CompareDiff` (original strikethrough `--destructive` tint / refined `--success` tint), `GuidanceBar`, `StatusLine` (session/tokens/model). |
| **ConnGraph** | RAG connections as a thread-web. **Cap node count** (cluster overflow) — hardening. Uses `--chart-*` / `--primary`. |
| **EmptyState** | what-goes-here + why + one CTA + WeaveGlyph. Variants: first-use · cleared · no-results · error. |
| **StatusBar** (Loom) | VS-Code-style: branch / model / tokens / cost / latency. Mono. |

## States, motion, hardening (enforced via theme.css + conventions)

- **Focus**: global `:focus-visible` ring (in `theme.css`). Per-component focus
  only to refine, never to remove.
- **Loading**: Skeleton (with silk shimmer), not center spinners. Stream LLM text.
- **Errors**: every LLM call surfaces timeout / 429 / provider-down / partial with
  a message + retry; never an endless spinner. Disable submit while in flight.
- **Destructive**: undo-toast (sonner) over confirm dialog; confirm only for
  irreversible (wipe corpus).
- **Overflow**: `min-w-0` on flex children, truncate/line-clamp, `overflow-wrap`;
  logical properties for RTL. Long/emoji/CJK names are expected input.
- **Motion**: `--motion-fast/base/layout`, `--ease-out-expo`; spend only on
  message arrival, theme cross-fade, Refinery stage + silk, streaming. No bounce.
- **Virtualize** long threads/corpus with `@tanstack/react-virtual`.

## Satellite theming (bridge to tokens)

recharts → `var(--chart-1..5)`, axes/grid → `--border`/`--muted-foreground`,
tooltip → `--popover`. · CodeMirror → one theme mapping editor surfaces to tokens.
· sonner → `--popover`/`--border`. · scrollbars + resize handles → neutral ramp.
