# Elastic E1 evidence: service health and known issues

Status: 2026-10-12. E1 from [plan 14](../../plans/14-elastic-implementation.md), built and tested against the mock Elastic. As with E0, no real
Elastic deployment has been called.

## What exists

**App mappings** (Administration → Integrations → Application mappings; API `/api/admin/integrations/mappings`)
- **What a mapping names:** per application and environment:
  - a connection and services (name and environment, plus `labels.app` or `service.namespace` for a shared service)
  - data streams per family
  - SLO, monitor and rule ids, and case tags
  - an optional Kibana link base
  - how customers are matched
- **Activation:** saving makes a draft. A draft is never polled.
- **Preview:** reads each configured family once and shows what it finds, with optional event counts for a known test customer. It fails on any unknown SLO id, any monitor with no executed result in 24 hours, or any family that's refused or errors.
- **Isolation check:** for every other mapping on the same connection, it counts events matching both mappings' service selectors and lists any SLO, monitor, rule or case tag both claim. Anything shared fails.
- **Activating:** only after both checks pass for the current revision; the database enforces this too. Any edit returns the mapping to draft and clears both results. "Check health now" schedules an immediate poll.
- **Audit:** every save, check and state change.

**Integration worker** (`npm run dev:integrations`, `apps/api/scripts/integration-worker.mts`)
- **Scheduling:** one `poll` operation per active mapping, claimed with a 60-second lease and a fencing token.
- **What each poll does:**
  - reads SLOs, alerts, synthetics (last 15 minutes) and cases
  - aggregates health (`apps/api/lib/integrations/elastic/health.ts`)
  - counts affected subjects per issue: distinct instrumented `user.id`s with errors on the mapped services since the issue began. This is Elasticsearch's approximate cardinality, and is labelled that way.
- **Commit:** the snapshot, known issues and a `NOTIFY` go in one transaction, and only while the worker still holds its lease.
- **Failures:**
  - **429:** honours Retry-After.
  - **Network or server failures:** back off exponentially to five minutes and keep the last snapshot, which goes stale after two missed polls.
  - **A refused credential:** records "unavailable" at once.
  - **A family that failed to read:** never closes an issue.
- **Retention:** history older than 24 hours is pruned; the latest snapshot always stays.

**Read models and stream**
- **`GET /api/observability/health`:** every registered app has an entry. Each says healthy, degraded, critical, unknown or out of date, or else why there's nothing to show: not mapped, kill switch on, credential refused, or not checked yet. Each entry also carries its source, its age and whether it's complete.
- **`GET /api/observability/issues`:** active alerts and open cases only.
- **`GET /api/observability/stream`:**
  - **Events:** content-free (`ready`, `health`, `issues`), delivered when the worker commits; kill-switch and mapping changes send them too.
  - **Browsers:** re-read Resolve's snapshots on each event. Neither the browser nor the API calls Elastic for a page view.
  - **Sessions:** re-checked every 30 seconds.
- **Linking tickets** (`/api/apps/{app}/observability/issues/{id}/candidates` and `/links`):
  - **Candidates:** the person's own open tickets in that app that changed during the issue.
  - **Pre-selection:** none, because the customer's own errors can't be compared until E2.
  - **Linking:** each ticket is re-read with the person's own grant before it's linked, so a hidden or invented id is refused. A repeated request links nothing twice.
  - **Where links live:** in Resolve only. Linking needs `observability.link` and `ticket.read`; observers can't link.

**Console**
- **Home:** cards follow prototype board 2 ("Your applications · live health"). Each application card shows:
  - **Header:** name and description, with a dot-and-text status (Operational, Degraded, Critical, Unknown, Out of date).
  - **Current issue:** in one line, in an amber box; an open case is preferred to an alert's text.
  - **SLO:** the worst SLO with its target and reported burn rate ("Payslip downloads available 99.5% · burning 4.2x"), or "All within budget".
  - **Active alerts.**
  - **Synthetics:** a strip of the last 12 executed runs with a passed/total count. A screen-reader sentence names what's failing now. With no recent results it says "No recent results"; with no monitors mapped, "Not configured".
  - **Footer:** "Your clearance T1/T2/T3" and the app's open-ticket count.
  - **Under the grid:** "Health from Elastic SLOs, alerting rules and Synthetics · refreshed …".
  - **The whole card links to the application's page.**
- **Application page** (`/apps/{appKey}`, also from the navigation):
  - **"What was checked":** every SLO, alert rule and synthetic check, with its source, state and what Elastic reported, plus the recent synthetic runs.
  - **The connection:** state, access, clearance, and Connect, Reconnect, Check connection and Disconnect. Connecting returns to this page.
  - **That application's known issues.**
- **Clearance (QB-TIER-1):**
  - **Source:** the fork's tiered support (its plan v2/30) isn't built yet, so the tier comes from a new target tool, `get_my_tier`, which the mock tenants implement.
  - **When nothing is shown:** an app that doesn't advertise the tool, can't be reached, or reports no tier (observers) shows "—", read out as "not reported".
  - **Endpoint:** `GET /api/clearance` (`ticket.read`).
- **"Known issues":** source, age, approximate affected customers and linked tickets, with "Link tickets…" opening an inline review where every ticket must be chosen.
- **Nav:** a degraded or critical app gets a mark, and its accessible name says "service degraded".
- **Announcements:** state changes are announced politely through the single app-wide live region, never on every refresh.
- **Accessibility:** state is shown as text and an icon, never colour alone.

## Prototype corrections applied (plan 14 §2)

- **Burn rate:** shown only as Elastic reports it, with its window, never computed from a percentage.
- **"312 customers affected":** became "about N affected customers (approximate; instrumented customers with errors since it began)".
- **"Matching tickets":** counts linked tickets. Candidates are shown separately and never assumed.
- **Left out:** "Live activity ✓ verified in logs" (E3) and "Customer message".
- **Clearance:** shown as the application reports your tier; it's never inferred by Resolve.
- **Run strip data:** the strip shows real executed runs, not a fixed 10–12 tick decoration.

## Exit criteria (plan 14, E1)

| Criterion | Evidence |
|---|---|
| Degraded, empty, stale, permission-denied and kill-switch states are correct | `observability.unit.test` › aggregation (violated becomes critical; no data, missing SLOs and monitors that never ran are unknown; partial and unavailable; stale); `observability.db.test` › refused credential (`connection_unavailable`), kill switch (`kill_switch`, no issues), network trouble (stale, last components kept); `observability.spec` › Legal "Not connected to Elastic", kill switch shown live |
| No cross-app data | `observability.unit.test` › isolation: payroll and HR share notification-service and pass only with discriminators; without one, overlapping events fail; a shared SLO id fails. `observability.spec` › activation is refused while isolation fails |
| An Elastic outage doesn't break support chat | `observability.spec` › with the mock returning 503, the inbox, conversations and tickets still load |
| No per-browser polling fan-out | Browsers read snapshots on stream events. Only the worker calls Elastic; the database test checks that a poll's NOTIFYs arrive only on commit |
| Leases, fencing and backoff | `observability.db.test` › a worker that lost its lease writes nothing; Retry-After is honoured; network failures back off beyond the poll interval |
| Known issues | `observability.db.test` › an alert and a case with 18 approximate affected subjects and redacted reasons; a recovered alert leaves the list; a failed read closes nothing |
| Linking is confirmed and authorized | `observability.spec` › nothing pre-selected; linking one chosen ticket; an invented ticket refused (`not_found`); an observer gets no button and a 403 |
| WCAG 2.2 AA | axe on the mapping page and on home with health and known issues |

Full run on 2026-10-12:

| Suite | Result |
|---|---|
| Typecheck and console build | Clean |
| Unit | 246 passed |
| Database | 71 passed |
| Contract | 31 passed |
| Browser (Chrome, one worker) | 78 passed |

## Found while building

- **Stale console dev server:** the long-running `ng serve` had stopped rebuilding. The cause was a real template type error (an icon name typed as `string`), which the dev server had swallowed while still serving its last good bundle.
- **`npm run typecheck` hid it:** the Angular CLI now requires Node 24.15 or newer, as does the repo's `engines`, and this machine has 24.4. The CLI exits with a version message, and the typecheck output never showed an "error" line, so a broken console build went unnoticed.
- **Node is still an environment problem:** the console build and dev server here were run by calling the CLI's bootstrap directly. Installing Node 24.15+ (the `.node-version`) is the real fix.
- **Two live regions** broke the single-announcer rule the inbox relies on. There is now one app-wide region with the latest message from either source.

## Not yet done

- **Real data:** health against a real deployment depends on E0's live access.
- **Alert reads:** confirm against the deployed rule types that reading alerts from `.alerts-observability.*` is the supported way.
- **Defaults to confirm (plan 12 §10.7):** 30-second polls and 24-hour retention need owner approval and E5 load figures.
- **Candidate matching:** comparing the customer's own errors in the issue window waits for E2 (QB-OBS-1 and per-app `user.id`).
