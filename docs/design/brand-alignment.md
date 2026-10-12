# Brand alignment

Resolve uses the Interop design system (`design/reference/interop-style-guide.html`) and follows the
Resolve console prototype (`design/reference/resolve-console.html`) for its shell and brand.

## What is carried over

- **Mark:** the lifebuoy, rotated 17.5°. It appears on an accent tile in the top bar and favicon, and large in the launchpad hero
  (`apps/console/src/app/icon.component.ts`, `apps/console/src/favicon.svg`).
- **Shell:**
  - a 58px translucent top bar with the brand name and the "Unified support operations" tag
  - a 248px sidebar: Home, the application list, then Administration
  - a masked 44px grid background
  - a launchpad with a hero, an application card grid and a right-hand column
- **Tokens:** the prototype's names and values in `packages/design-tokens/styles.css`, for light and dark themes and
  compact/balanced/spacious density. Fonts are Geist and Geist Mono, self-hosted.
- **Components:**
  - **Buttons:** ink primary buttons, with accent for emphasis, plus secondary and ghost variants.
  - **App cards:** the accent edge appears on hover or focus.
  - **Indicators:** status dots, tone tags, mono chips, uppercase section labels and card headers.
  - **Icons:** the 1.6px-stroke Interop icon set.
  - **shadcn controls:** they map to the same tokens, so their primary variant is ink and their focus ring is accent.
- **Voice:** sentence case, plain and verb-first copy, no exclamation marks, and errors that say what failed and what to do.

## Accessibility adjustments (WCAG 2.2 AA)

Only values that failed a required contrast pair were changed. `tests/design-tokens.unit.test.ts` enforces every pair.

| Token | Reference | Resolve | Reason |
|---|---|---|---|
| light `--ink-3` | #6b7280 | #646b78 | Muted text failed 4.5:1 on inset and accent-tinted surfaces |
| light `--ink-faint` | #9aa1ac | #848b97 | Icons need 3:1. Faint is never used for text; labels use `--ink-3` |
| light `--destructive` | #d44a3f | #c23b31 | White button labels failed 4.5:1 |
| dark `--accent` | #5b76ff | #4d68f5 | White labels on accent fills failed 4.5:1 |
| dark `--ink-3` / `--ink-faint` | #868d99 / #5b626d | #8f96a2 / #6b7385 | Text 4.5:1 / non-text 3:1 on inset surfaces |
| accent and status text | base colour | `--accent-ink`, `--safe-ink`, `--sensitive-ink`, `--destructive-ink` | Base colours failed on their tinted backgrounds |
| input borders | `--border` | `--control-line` | Control boundaries need 3:1 (1.4.11) |
| smallest text | 10.5px (compact) | 11.5px | Legibility at compact density |

Tinted backgrounds (`--*-soft`) are fixed hex values computed from the prototype's colour mixes, so the
contrast tests can verify them.

## Not carried over yet

- **Command palette, notifications and the apps-grid button:** these need real behaviour first (Phase 2 and later).
- **Tier badges, escalations and the live activity feed:** they arrive with the dashboard and inbox work (plans 09 and 11).
- **Per-app hue avatars:** Resolve uses neutral mono glyphs until there's an approved per-app colour rule.
