# Phase 2 evidence — internal fleet-read milestone

Status: 2026-10-12. Built and tested against the development mock fleet (`tools/mock-tenant`). That fleet implements
the gap-fixed tenant contracts Resolve targets; the Quackback fork does not provide them yet (see Dependencies).

## What exists

- **Target tenant contracts:** `packages/contracts/src/fleet-read.ts` defines the tool versions Resolve requires:
  - `list_tickets` v2 with a keyset cursor
  - `get_conversation` v2 with list-equal visibility, attachments, team and links
  - `get_support_dashboard` and `list_support_activity`

  It also defines the protocol endpoint (`/api/resolve/protocol`) and Resolve's read API schemas.
- **Tenant tool client:** `apps/api/lib/tenants/mcp.ts` sends MCP `tools/call` with the signed-in person's own grant and
  validates every result against the contract. A drifting response is a tenant error, not data.
- **Compatibility probe:** `apps/api/lib/tenants/protocol.ts` implements contract 6. A tenant without the required versions is
  `incompatible` and is never called. Dormant and unavailable apps are never probed.
- **Fan-out:** `apps/api/lib/fleet/fanout.ts` handles fleet-wide reads:
  - at most 6 apps at a time, with a 4 s timeout per app
  - every result carries its app, as either ok or unavailable with a reason and a retryable flag
  - dormant apps are skipped unless explicitly included
- **API:**
  - `GET /api/dashboard` returns per-app KPIs, totals from `sumMetric` that name the missing apps and why, and the latest activity per app.
  - `GET /api/tickets` and `GET /api/conversations` return the first page from every app.
  - `GET /api/apps/:app/tickets|conversations[?cursor]` returns one app's next page.
  - `GET /api/apps/:app/tickets/:id` and `GET /api/apps/:app/conversations/:id` return a detail page.
  - `GET /api/apps` now includes `dormant` and `health`.
- **Console:** Angular router pages for Home, Tickets, Conversations, the two detail pages, Audit and Component check.
  - **Home:** KPI tiles with coverage text, recent activity, and app cards with health.
  - **Lists:** per-app sections with "Load more from …", an explicit unavailable message, and "Load …" for idle apps.
  - **Navigation:** focus moves to the new page heading, including after async detail loads, and each route sets the document title.

## Exit criteria (plan 00)

| Criterion | Evidence |
|---|---|
| Row-level authorization holds on direct IDs | `tests/browser/fleet.spec.ts` › direct IDs…: a ticket or conversation visible to the admin but not the agent returns 404 for the agent, through the API and the page. `tests/mock-tenant.unit.test.ts`: detail visibility equals list visibility |
| Partial failures do not hide successful results | `fleet.spec.ts` › one failing app…: HR erroring or timing out leaves Payroll's results and totals intact, and HR shows a retryable unavailable state. `tests/fanout.unit.test.ts` |
| No app wakes because a dashboard polls | `fleet.spec.ts` › a dormant app is never woken…: the mock tenant records zero tool and protocol calls through dashboard loads and refreshes, and calls start only after "Load Legal Ops". `fanout.unit.test.ts` |
| Pagination neither loses nor repeats items | `fleet.spec.ts` › per-app pagination…: 130 tickets with timestamp ties, paged through the API and the UI. `mock-tenant.unit.test.ts` |
| Unavailable is never shown as zero | `fleet.spec.ts` › missing analytics permission…: HR has no analytics access for observers, so its metrics are listed as missing. `tests/contracts/wire.unit.test.ts` (`sumMetric`) |
| Accessibility | axe (WCAG 2.2 A/AA tags) on Home with KPIs, Tickets with a failed app, and ticket detail. Focus moves to the heading on navigation |

## Design notes

- **Pagination is per app** (plan 01). A globally sorted list would need a k-way merge that keeps unconsumed rows; it isn't claimed.
  The Home activity list merges each app's latest entries for display only.
- **A single-app request counts as explicit** and may start a dormant app. Fleet-wide reads only start the apps named in `include`.
- **No read cache yet.** Plan 01 asks for per-user, per-app, per-permission-version caching with invalidation on role changes or denial.
  That's deferred until load testing shows it's needed; today every read goes to the tenant.
- **Browser tests run on one worker** because they share the fixed mock users and the fleet state.

## Dependencies on the Quackback fork (unchanged gaps)

| Needed for | Gap |
|---|---|
| KPI tiles and activity | QB-DASH-1, QB-DASH-2 |
| Safe conversation detail by ID; complete thread data | QB-CHAT-4, QB-CHAT-5 |
| Ticket paging beyond 100 | QB-TICKET-1 |
| Attachment downloads (names only today) | QB-FILE-1 |
| Version advertisement (`/api/resolve/protocol`) | QB-PROTO-1 |
| Registry projection with `dormant` | QB-REG-1 |
