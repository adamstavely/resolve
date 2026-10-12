# Phase 0 evidence — component bridge gate (plan 06)

Status: automated evidence passing 2026-10-12; manual assistive-technology checks outstanding (below).
Scope: Angular application composing official shadcn/ui React controls exposed as registered custom elements.

## Result

The adapter architecture works for the gate's required cases — dialog, combobox, validated text input,
theming and portal placement — with native form semantics, focus management and typed Angular bindings.
Recommendation: accept the architecture, subject to the outstanding manual checks.

## Architecture decisions

| Decision | Reason |
|---|---|
| Light DOM (no shadow root) | `label for`, `aria-labelledby` and `aria-describedby` cannot reference IDs across shadow roots; Radix portals render to `document.body`; Tailwind utility styles must reach element content. The element API is the encapsulation boundary. |
| One React runtime, one root per element | All elements register from one bundle (`registerElements()`), so React is loaded once. Per-instance roots keep elements independent. |
| Element owns state | Components are controlled by element properties and write back through the adapter, so Angular bindings, attributes and form reset cannot disagree. |
| Form-associated elements (`ElementInternals`) | Values submit through native `<form>`/`FormData`, take part in `checkValidity()`/`reset`, and respect `fieldset disabled`. |
| Inner `<input>` is always `type="text"` | Light-DOM inputs inside a form join constraint validation even without a `name`; validation is done by the element instead, using `inputmode` for keyboards. |
| `disabled` reflects to the attribute | The platform treats a form-associated element as disabled only through the attribute. |
| Element's own error text, no browser bubble | `invalid` is cancelled; errors render inline, linked by `aria-describedby`, with an `Error:` prefix that isn't conveyed by colour alone. The first invalid element is focused. |
| Dialog restores focus explicitly | Radix restores focus only to its own `Trigger`; property-opened dialogs record and restore the invoking element. |
| Typed Angular adapters | A directive per tag provides typed `input()`/`model()` bindings checked by `strictTemplates`; `CUSTOM_ELEMENTS_SCHEMA` is still needed because directives don't declare elements. |

Attributes are inbound only (initial or static configuration); properties are the runtime API.
Events bubble and are `composed`.

## Element contracts

| Tag | Properties (attribute) | Events | Form | Focus |
|---|---|---|---|---|
| `resolve-text-field` | `label`, `value`, `hint`, `error` (owner/server error), `required`, `disabled` (reflected), `maxlength`, `kind` = text\|email\|url, `autocomplete` | `value-change {value}` | value, `valueMissing`/`typeMismatch`/`customError`, reset | `focus()` → input |
| `resolve-combobox` | `label`, `value`, `options` (JSON `{value,label}[]`), `placeholder`, `search-label`, `empty-text`, `hint`, `required`, `disabled` (reflected) | `value-change {value}` | selected value, `valueMissing`, reset | `focus()` → trigger |
| `resolve-confirm-dialog` | `open`, `heading`, `description`, `confirm-label`, `cancel-label`, `tone` = default\|destructive, `pending` | `confirm` (cancelable — `preventDefault()` keeps it open), `cancel` | — | destructive → Cancel first; restores focus to the invoker |

Loading/disabled states: `pending` keeps the confirm dialog's controls visible but inert (`aria-disabled`) and announces "Working…".
Sources: `packages/elements/src/core/define.tsx`, `packages/elements/src/elements/*`, Angular adapters in `apps/console/src/app/elements.ts`.

## Automated evidence

Commands: `npm test` (unit), `npm run test:e2e` (Playwright + axe-core 4.13, tags wcag2a/aa, 21a/aa, 22aa).

| Requirement (plan 06) | Test |
|---|---|
| Token contrast, both themes (1.4.3, 1.4.11) | `tests/design-tokens.unit.test.ts` (58 pairs) |
| No remote font/resource loads; Geist self-hosted | `foundation.spec.ts` › backend contract, self-hosted fonts and no external requests |
| axe in light and dark (fixed balanced density); 320px reflow | `foundation.spec.ts` › axe in both themes |
| Text spacing (1.4.12) at 320px | `foundation.spec.ts` › text spacing override |
| Labels/errors linked across element boundary; first-invalid focus | `components.spec.ts` › submitting an empty form… |
| Keyboard-only combobox; portal (popover) axe; native form value | `components.spec.ts` › keyboard-only completion… |
| Format validation and recovery | `components.spec.ts` › format errors… |
| Reset propagates to elements and Angular models | `components.spec.ts` › reset clears… |
| Dialog focus trap, cancel default, Escape, return focus | `components.spec.ts` › destructive confirmation… |
| Upgrade-safe properties, attribute parsing, composed events, disabled/fieldset, move without remount | `components.spec.ts` › element contract |

The suite was run three times in a row (`--repeat-each=3`) with no failures, using Google Chrome 154 via `PW_CHANNEL=chrome`.

Harness note: colour transitions are allowed to finish before axe samples contrast. Earlier failures came from
sampling mid-transition, not from the final colours. `prefers-reduced-motion` removes transitions.

## Outstanding before the gate fully closes

1. Manual screen-reader checks: NVDA + Chrome/Firefox, VoiceOver + Safari. Especially the shadcn combobox,
   which nests cmdk's search `combobox` inside a popover opened from a `combobox` button. Confirm name,
   value and expanded state are announced, plus the dialog/alertdialog announcement and the error description being read on focus.
2. 200% text resize and 400% zoom manually; Firefox and Safari engines in Playwright (only Chrome run so far).
3. Owner confirmation of the "everything as Web Components" interpretation (plan 06): reusable controls and
   screen boundaries are custom elements, and Angular templates still use native elements inside them.
4. `@angular/forms` is not installed; add a `ControlValueAccessor` adapter when the first real form (onboarding) needs reactive forms.
5. shadcn `AlertDialog` (`@radix-ui/react-alert-dialog`) isn't installed; destructive confirmation uses `Dialog` with `role="alertdialog"`. Switch if the manual checks find a difference.
6. Add the upstream Geist `OFL.txt` and record font approval (`packages/design-tokens/fonts/README.md`).
7. Production initial bundle: 953 kB raw / 214 kB estimated transfer, with Angular and React together. It was 1.46 MB until the unused JIT `@angular/compiler` import was removed. Set budgets and lazy-load routes once real screens exist.
