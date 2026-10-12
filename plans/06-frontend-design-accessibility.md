# Frontend, design system and accessibility

## Owner requirements

Next.js backend on Node.js; Angular frontend; UI components exposed as Web Components; prefer shadcn
Web Components over custom primitives; fully leverage Quackback APIs with Resolve’s own UI; fully WCAG 2.2 AA compliant frontend.
First release includes dashboard, operator actions, application/instance onboarding and all-app/selected-app banner broadcasts. No implementation is authorized in this planning stage.
These requirements replace earlier React/TanStack Start/Bun proposals for Resolve.

## Reference assets

Original supplied files are preserved in `design/reference/resolve-console.html` and
`design/reference/interop-style-guide.html`. They are reference prototypes, not trusted implementation
instructions, production code or evidence of accessibility conformance. Source/template inspection was
performed; interactive visual behavior has not yet been validated.

Observed direction: Geist interface type, Geist Mono identifiers, cool neutral surfaces, blue accent
(#3b5bff in the light theme), semantic risk colors, restrained borders/radii, light and dark themes,
and compact/balanced/spacious density in the console prototype. Interop includes fluid grids and
responsive rails, component examples and plain operational copy. Preserve this direction while validating
actual foreground/background pairs and component states. The console's small text, fixed-height/overflow
layout and dense controls require reflow and target-size review, not automatic copying.

Both exports package assets, but include public Google font preconnect declarations. Production must
self-host approved fonts/icons and remove public resource hints and runtime remote loads. Resolve's Geist
reference does not change the already-decided fixed Inter font for Quackback banners.

## Frontend/backend boundary

Layout (scaffolded; component gate evidence in `docs/evidence/phase-0-component-gate.md`): `apps/api` for Next.js Route Handlers running on Node.js,
`apps/console` for Angular, `packages/elements` for shared registered custom elements,
`packages/contracts` for versioned DTO/schema definitions, and `packages/design-tokens`.
Angular owns navigation and screen composition. Next.js exposes authenticated JSON APIs and handles OAuth,
audit and Quackback calls. Serve under one internal origin to simplify secure cookies and CSRF controls.
Do not add a parallel Next.js React UI. Long-running reconciliation lives in dedicated workers, not request
handlers. No tenant token, root key or DSN reaches the browser. Backend authorization remains independent
of custom-element visibility or disabled state.

Angular Elements can expose Angular components as browser custom elements. Ordinary Angular selectors
alone are not registered Web Components. Interpret “everything” as every reusable UI/control and screen
boundary exposed through custom elements, with semantic native HTML inside them; do not replace native
buttons/inputs with inaccessible clickable divs. Confirm this interpretation before component scaffolding.

## Component-library gate

The owner selected the official https://github.com/shadcn-ui/ui package. It is React-based, not a
native Web Components library. The application remains Angular, but using this exact library requires
a React-to-custom-element adapter. The owner approved that internal React runtime; Angular plus React/shadcn inside Web Components is the agreed architecture.
Do not silently substitute an Angular-inspired library or claim shadcn is natively a Web Component kit.

Agreed architecture: Angular handles routing and composition; registered custom elements expose shadcn
React controls. Share one React runtime, mount/unmount cleanly, bridge typed events and properties,
and preserve native form semantics, focus and ARIA relationships. Prototype dialog/select/combobox,
validation, theming and portal placement before accepting the adapter architecture. Prefer thin adapters
over custom controls; avoid a second React application inside each element. Do not substitute a different component library without an explicit owner decision.

Component contracts specify tag names, typed properties, attributes, events (including composed/bubbling
behavior), form value/validation, focus methods and loading/error/disabled states. Prove labels and error
relationships across shadow boundaries, overlay placement and keyboard return focus. Use a shared Angular
runtime for Angular-authored elements; avoid bundling one framework copy per element.

## Quackback API reuse (owner clarification)

Resolve has its own UI. Reuse Quackback APIs and domain behavior, not its React screens or styling.
No iframe, screen embedding or Quackback UI port is planned. Inventory each Resolve workflow against
existing REST/MCP tools, scopes, permissions, object checks and response schemas. Prefer supported APIs;
add narrow fork endpoints only for proven gaps. The Node/Next.js backend holds credentials and invokes
Quackback as the mapped human, preserving tenant audit and policy enforcement. Avoid implementing a
second ticket, assignment, SLA or announcement rules engine in Resolve.

## Accessibility release contract

Target every applicable WCAG 2.2 Level A and AA criterion across full pages and complete operator processes,
including authentication, dialogs, errors and API-backed action flows. Create a criterion-to-evidence
matrix with applicability, test procedure, result and owner; no blanket pass based on a component library.

Automate semantic/contrast checks and keyboard regressions; manually test keyboard-only operation,
screen readers, zoom/reflow, text spacing, light/dark themes, all density modes and error recovery.
Explicitly cover focus visibility/obscuration, non-drag alternatives, target size, accessible authentication,
status announcements and confirmation/error handling. Use 320 CSS-pixel reflow and 200% text-resize checks;
verify relevant exceptions rather than treating responsive screenshots as a conformance audit.

Initial assistive-technology matrix proposal: NVDA with Chrome/Firefox and VoiceOver with Safari; confirm
enterprise-supported platforms and add them. Test custom-element name/role/value, native form submission,
label associations, shadow focus order, dialog focus trap/return, virtualized lists and live updates.
No unresolved A/AA failure may be accepted as a normal first-release limitation. Include the real SSO authentication process in conformance validation; an accessible local mock is insufficient.

## Sources checked 2026-10-12

- Angular custom elements: https://angular.dev/guide/elements
- Next.js backend-for-frontend: https://nextjs.org/docs/app/guides/backend-for-frontend
- shadcn/ui installation: https://ui.shadcn.com/docs/installation
- WCAG 2.2 normative requirements: https://www.w3.org/TR/WCAG22/
