# Elastic integration — implementation plan

Status: proposed, 2026-10-12. This turns [plan 12](12-elastic-observability-integration.md) and the `design/reference/resolve-integrations.html`
prototype (seven boards) into buildable work for this repository. Scope is the confirmed first release: E0–E2, with
E5 qualification folded into Phase 6. E3 (pre-flight and verified receipts), E4 (ML patterns, AI summaries) and the
ServiceNow boards are out of scope.

## 1. Owner decisions applied (2026-10-12)

1. **Deployment:** Elastic Cloud Hosted 9.x, reached over a private link. Until E0 has access, build against a mock
   Elastic shaped like 9.x responses; E0 replaces the mock fixtures with recorded, sanitized real ones and pins the
   exact build.
2. **Customer matching:** the fork's verified `external_id` (the host app's JWT `sub`, set only on the signed-token
   identify path) is the app subject. Customers without a verified `external_id` get service-level context only. No
   tenant tool exposes it today, so this is a new gap, **QB-OBS-1**. The application's telemetry must emit that same ID as
   `user.id` (ECS); this is an instrumentation prerequisite per app, not something Resolve can infer.
3. **Evidence:** a snapshot is an immutable Resolve record tied to a Quackback ticket or conversation. Resolve also posts an
   internal note linking to it, as the agent, using the existing note tools. Elastic Cases are read-only; links between
   tickets and cases or known issues are stored in Resolve. Resolve does not write to Elastic.
4. **Access:** capabilities, not the prototype's tiers (T1–T4):

| Capability | Kind | Grants | Bundles |
|---|---|---|---|
| `observability.health` | read | App health, SLOs, alerts, synthetics, known issues | agent, observer, admin |
| `observability.subject` | read | One customer's timeline and service context, inside a ticket or conversation the viewer can already read | agent, admin |
| `observability.link` | mutation | Link a ticket to a known issue; capture a snapshot (and post its note) | agent, admin |
| `observability.restricted` | read | Redacted trace and log drilldown, trace IDs, Kibana links, snapshot export | new `observability-investigator`, admin |
| `observability.configure` | administration | Connections, app mappings, preview and isolation check, kill switch | admin |

**Defaults assumed until the owner says otherwise** (plan 12 §10, still open):

- **Retention:** health cache 24 h; snapshots 30 days, with a hold flag.
- **Refresh:** health every 30 s; subject context every 60 s while it's visible; stale after two missed polls. Load tests treat these as inputs.
- **E0:** someone owns setting up the private link and the read-only API keys. That owner is still unnamed.
- **Customer message:** no "copy customer message" in v1 (see §2).

## 2. Prototype review: what we build, adapt or leave out

The boards are mock data. Several conclusions they show aren't supportable from Elastic alone (plan 12 §1). The rule
throughout: **facts, observed correlations, coverage limits and hypotheses are shown separately, and no data never means healthy.**

**Board 1: customer view with system context (E2)**
- **Build:**
  - The known-issue banner on the ticket or conversation, with the matched and missing criteria.
  - "What the systems saw" (APM and RUM events for the subject).
  - "Is it us?" (synthetic checks by region).
  - The "Customer + systems / Customer only" timeline.
  - Trace IDs and Kibana links for `observability.restricted`.
  - "Link to known issue".
- **Adapt:**
  - "Customer" events are this person's Quackback conversation and ticket events, not application business data.
  - The region for "near the customer" comes from RUM `client.geo` and is labelled as derived.
  - "312 customers affected" becomes "312 distinct instrumented subjects (approximate) since 21:47".
  - "2 of 3 disputed transfers fall in this window" becomes "N of this subject's errors fall in the window".
- **Leave out:**
  - The wallet balance, limits, KYC and cards strip, and the account-tools sidebar (no executor; plan 00 phase 3).
  - Quick actions.
  - "Copy customer message": there's no approved-message source yet.
  - ML log patterns (E4).
- **Correct:**
  - "Both payments settled": a 502 and a retry prove two settlements only if the app reports them.
  - "Sign-in looks legitimate": MFA passing doesn't prove the person.
  - "Very likely not specific to Devon": show the facts, not a verdict.

**Board 2: home with service health (E1)**
- **Build:**
  - Per-app health cards: state, SLO with its window and budget, active alerts, synthetics pass/total, refreshed-at.
  - A degraded marker on nav entries, with text as well as icon.
  - A known-issues panel listing affected subjects, matching tickets and the case ID.
  - "Link tickets" for candidates.
- **Adapt:**
  - "Matching tickets" counts tickets linked in Resolve, plus candidates shown separately.
  - Open tickets keep the existing KPI cards (plan 11), labelled apart from Elastic data.
  - Burn rate is shown only when the SLO API returns it for its window; nothing is computed from a percentage.
- **Leave out:**
  - "Your clearance".
  - "Live activity ✓ verified in logs" (E3).
  - "Customer message".

**Board 3: action guardrails.** Leave the whole board out (E3, deferred).

**Board 4: escalation with evidence snapshot (E2)**
- **Build:** the snapshot itself:
  - service health at capture
  - the subject's errors against the incident window
  - sign-in and RUM facts
  - "already tried": Resolve audit for this ticket
  - capture time, completeness, source IDs and content hash
- **Adapt:**
  - The snapshot attaches to the ticket or conversation, and the internal note links to it.
  - Reviewing is just reading: whoever can read the ticket and holds `observability.subject` (restricted items need `.restricted`).
- **Leave out:**
  - The escalation request and approve/deny decision (no escalation workflow).
  - The AI draft summary (E4).
  - Log patterns (E4).

**Boards 5–7: ServiceNow.** Leave them out (plan 13). Keep the data model ready for INC links later.

## 3. Shape in this repository

```
packages/contracts/src/observability.ts     DTOs (health, issue, subject context, snapshot, mapping, connection), zod, schemaVersion
apps/api/lib/integrations/elastic/
  client.ts        HTTPS client: host allowlist, every resolved address checked, no redirects off-host, CA pinning, timeouts, 429 Retry-After
  queries.ts       Parameterized, projected, time-bounded queries per family (no user DSL/KQL)
  families/        slo.ts, alerts.ts, synthetics.ts, apm.ts, rum.ts, cases.ts — each parses into contracts, fixture-tested
  redact.ts        Field allowlist + secret/token/payment/PII scrubbers before cache, log, export
  health.ts        Aggregation: unknown | healthy | degraded | critical | stale, with completeness
  correlate.ts     Known-issue matching (matched + missing criteria), affected-subject counts (exact vs approximate)
apps/api/lib/observability.ts                Read models, authorization, snapshots, links, audit
apps/api/app/api/apps/[appKey]/observability/**   Routes from plan 12 §5 (minus preflight/receipt)
apps/api/app/api/admin/integrations/**        Connections, mappings, preview, isolation check, kill switch
apps/api/scripts/integration-worker.mts        Durable worker: leased polling per connection/app, checkpoints, backoff, outbox
packages/database/migrations/0008.sql
tools/mock-elastic/                            Mock ES + Kibana (9.x shapes), scenarios, fault injection, fixture recorder
apps/console/src/app/pages/…                   Health on home, known issues, context panel, snapshot view, admin pages
```

- **Worker:** a dedicated entry point, separate from `fleet-jobs.mts`. Each app/connection pair takes a lease with a fencing token, so two workers never poll the same pair.
- **Live updates:** results are committed first, then an outbox publishes invalidations (`observability.health`, `observability.issue`) on the existing authenticated stream. The console subscribes before it reads and refetches by revision. Browsers never poll Elastic, directly or through Resolve.
- **Isolation:** Elastic is optional per app. An outage, a revoked key or the kill switch marks that app's observability *unavailable*. Chat, tickets and broadcasts are untouched.
- **Credentials:**
  - **Production:** a secret reference into the platform secret store.
  - **Development:** the key is sealed with the existing `sealer` (aad bound to connection id). Dev values go in `.env.example`.
  - **Keys:** read-only API keys, one per connection, restricted by index privileges to the mapped aliases and alert/synthetics indices. Keys never reach the browser.

## 4. Data model (migration 0008)

The tables from plan 12 §5, minus the E3 tables (`action_preflights`, `action_receipt_observations`, `issue_subscriptions`):

- **`integration_connections`:** provider (`elastic`, later `servicenow`), ES and Kibana URLs, space, CA, secret ref or sealed key, pinned version, capabilities found, enabled flag, kill switch, revision.
- **`elastic_app_mappings`:** app key, environment and revision, plus:
  - aliases and data streams, service names and environments
  - SLO IDs, monitor IDs, alert rule selectors, case tags and owner
  - deep-link base, subject policy (`verified_external_id` | `none`)
  - activation state: whether the preview and isolation checks passed
- **`integration_operations`:** leases, fencing tokens, payload digest, outcome, retry, `not_before`.
- **`integration_checkpoints`:** per connection, app and family.
- **`observability_health_snapshots`:**
  - Contents: app, observed and fetched time, `expiresAt`, per-component results, completeness, source IDs, mapping revision.
  - Retention: the latest row is kept, plus 24 h of history.
- **`known_issues`:** a normalized Elastic alert or case, unique on (connection, space, app/env, provider id); state, first and last seen.
- **`known_issue_links`:**
  - Columns: ticket or conversation, app, issue, linker, and the matched criteria at link time.
  - Constraint: unique on (issue, app, object).
  - Reserved: an `incident_ref` column for ServiceNow later.
- **`evidence_snapshots`:**
  - **Scope:** app, object (ticket or conversation), subject reference (hashed external id), requested and source windows.
  - **Content:** redacted facts (`jsonb`), source document IDs, query/rule revision, completeness.
  - **Classification:** the highest classification it contains (`service` | `subject` | `restricted`).
  - **Integrity:** content hash, revision chain, creator, capture time, `expiresAt`, hold flag.
  - **Note:** the internal note's operation id.

Snapshots are never rewritten. A refresh adds a revision that points at the one before.

## 5. Work packages

Each one ends with the full suite green and an evidence page under `docs/evidence/`, as in earlier phases.

### E0: contracts, mock Elastic and connection admin (can start now)

**Contracts**
- `observability.ts`: every response carries `schemaVersion`, `appKey`, `environment`, connection and mapping revision, `observedAt`/`fetchedAt`/`expiresAt`, source IDs and `completeness`.
- Health states include `unknown` and `stale`.
- The capabilities and the `observability-investigator` bundle are added to `capabilities.ts`.
- The tool gap is recorded in `tenant-tools.ts`:
  - **QB-OBS-1:** `get_conversation`/`get_ticket` (or a new `get_customer_identity`) return the customer's verified `external_id`, and whether it was verified.
  - It returns nothing on the unverified path and never derives one from email.

**Mock Elastic** (`tools/mock-elastic`)
- **Endpoints** (9.x shapes):
  - Elasticsearch `_search` and `_pit`, against APM traces and errors, RUM, logs, synthetics and `.alerts-observability.*`.
  - Kibana `GET /s/{space}/api/observability/slos`, `GET /api/cases/_find` and `GET /api/cases/{id}`.
- **Per-key behavior:** each API key has its own index privileges, so wrong-alias, wrong-space and revoked-key cases return real 403/401s.
- **Scenarios:**
  - Helio-style degraded transfers, an app with nothing wrong, and an app with no SLOs configured.
  - Two apps sharing a service name, to exercise isolation.
  - Two customers on one app.
- **Fault injection:** slow index, 429 with Retry-After, late events, mapping change, index rollover.

The mock tenant implements QB-OBS-1 with a verified/unverified flag on fixture customers.

**Fixture recorder:** a script that runs the adapter's own queries against a real deployment and writes sanitized responses. E0 runs it against Cloud Hosted.

**Connection admin**
- Create, test and rotate a connection, with HTTPS-only, allowlisted hosts.
- Version and capability discovery. Families that aren't available are recorded as unsupported, not hidden.

**Migration 0008:** applied, with database tests covering the uniqueness rules, leases and fencing.

**Exit:**
- Every query family has a positive and a negative-authorization fixture test against the mock.
- Contract checks run in CI.
- With a real key: one recorded positive and one negative call per family, and a written list of unsupported panels.

### E1: read-only health and known issues

- **Worker:**
  - Polls SLOs, alerts, synthetics and cases per mapped app: 30 s for active apps, opt-in for dormant ones.
  - Per-connection concurrency limits and backoff.
  - Writes health snapshots and known issues, then the outbox.
- **Health aggregation:**
  - Rules: no data or an unsupported family gives `unknown`; two missed polls give `stale`.
  - Partial results are marked `partial` and list the missing components.
- **App mapping admin:**
  - The mapping is edited per app and environment.
  - **Activation requires:**
    - a preview against a known synthetic subject, and
    - an isolation check: app B's mapping, run against app A's key and aliases, returns nothing.
  - Mappings are revisioned, and every change is audited.
- **Endpoints:**
  - `GET …/observability/health`
  - `GET …/observability/issues`
  - `POST …/observability/issues/{id}/links`: links tickets, with each candidate confirmed; idempotent on the operation key.
- **Console:**
  - Health cards on home, and the degraded marker in nav. Health always carries text and an icon, never colour alone.
  - The known-issues panel shows which criteria matched and which are missing.
  - "Link tickets" opens a review dialog, which lists candidates that differ (for example, a different error code) unchecked, with the reason.
  - "Refreshed Ns ago" is stated, and changes are announced politely, without stealing focus.
- **Audit:** an `observability` category: mapping and connection changes, links, and kill-switch use. Polling isn't audited, only its failures and state changes.

**Exit:**
- Correct states for degraded, empty, stale, unknown, permission-denied and kill-switch.
- No data crosses between the apps that share a service name.
- An Elastic outage leaves chat and tickets working.
- axe passes on every new view.

### E2: subject context and evidence snapshots

- **Subject resolution:**
  - QB-OBS-1 provides the verified `external_id` for the ticket's or conversation's customer.
  - A server-side check runs first: the viewer can read that object in that app, and holds `observability.subject`. Only then is any search run.
  - No verified id means service-level context, with a plain-language reason: "This customer wasn't identified by the app, so only service health is shown."
- **Endpoint:** `GET …/conversations/{id}/observability` and the ticket equivalent.
  - Default window 24 h, with a policy-bounded maximum.
  - Results are subject events, synthetic checks in the derived region, and matched known issues.
  - Paging uses PIT + `search_after`. Cursors are bound to app, viewer, permission revision, query hash and expiry.
- **Restricted drilldown:**
  - Trace and transaction IDs, redacted log lines, and Kibana deep links, which keep Kibana's own access control.
  - Only for `observability.restricted`, and each read is audited with source, actor and app.
- **Console:** a "System context" panel in the inbox thread and on ticket detail.
  - **Timeline toggle:** "Customer + systems / Customer only". Customer events are the Quackback thread events; system events come from APM, RUM and alerts, and carry source tags.
  - **Text alternatives:** every chart or timeline also has an ordered text version.
  - **Live refresh:** the panel refreshes every 60 s while visible, keeping focus and the selected ticket.
- **Snapshots:** `POST …/evidence-snapshots` captures what the viewer can see right now:
  - Content: health, matched issues, the subject's events in the window, and Resolve audit for this object ("already tried").
  - Classification: the snapshot is classified by the highest item it contains.
  - Internal note: posted as the agent through `add_ticket_note`/`add_conversation_note`, with the existing operation key and result lookup, so a lost response never posts twice. The note carries the link and the capture time, not the evidence itself.
  - Viewing: rechecked on every view and export. Restricted items are hidden, and their absence stated, for viewers without `.restricted`.
  - Refresh: adds a new revision.
- **Labelling:**
  - Affected-subject counts say whether they are exact or approximate, with their coverage and last update.
  - A sampled APM result says so.
  - No error found means "no matching events in window", never "no problem".

**Exit:**
- Customer isolation (A/B) and app isolation (A/B).
- An unverified customer falls back safely.
- A snapshot is reproducible: the same hash on re-read.
- A lost note response is reconciled, not duplicated.
- A restricted item is hidden from a non-investigator viewer.
- axe passes, and the keyboard drilldown is checked.

### E5 → Phase 6 (production qualification)

Added to the Phase 6 gates:
- **Load:** load at the agreed app and operator volume, using the existing harness and a new worker load script.
- **Failure handling:** reconnect storms, slow indices and late telemetry; retention expiry and rollover; mapping change, revoked key and a worker crash mid-lease.
- **Time:** DST and UTC windows.
- **Upgrade:** a 9.x minor upgrade rehearsed against the recorded fixtures.
- **Network:** a private-network trace showing no public egress.
- **Rollout:** feature flags per connection and app; canary on one nonproduction app, then one production app; a kill-switch drill.
- **Runbook:** written.

## 6. Tests to add

- **Unit:**
  - redaction
  - query builders (no injection, field projection)
  - health aggregation and staleness
  - correlation (matched and missing criteria)
  - cursor binding, snapshot hashing, capability bundles
- **Database:** 0008 constraints, leases and fencing, idempotent issue links, snapshot revision chain.
- **Contract:** the adapter parses every recorded fixture; the mock and the recorded fixtures agree on shape.
- **Browser (mock Elastic and mock tenant):**
  - home health states, known issues and link review
  - context panel for a verified customer, an unverified customer, and an observer (no subject panel)
  - investigator drilldown; snapshot capture, the note, and the re-view hash
  - kill switch; Elastic outage while chat keeps working
  - axe throughout

## 7. Sequencing and dependencies

1. **E0 contracts, mock and connection admin.** Nothing outside this repo is needed.
2. **E1 against the mock.** In parallel, E0's real part: private link, keys and recorded fixtures (owner: TBD).
3. **E2 against the mock** once QB-OBS-1 is specified. Two things go to other owners:
   - Building QB-OBS-1 is fork work, tracked as a gap (Resolve requires it to be advertised).
   - Per-app `user.id` instrumentation goes to the app teams.
4. **Phase 6** with the E5 gates.

**Before E2 can ship for real**, two things must be true:
- QB-OBS-1 is in the fork.
- At least two apps emit a verified `user.id`.

Until then, E2 runs in production as service-level only, which is the designed fallback.

## 8. Still open

- **Retention (plan 12 §10.3).** The defaults above need owner approval: snapshots 30 days, health 24 h.
- **Volume (§10.7).** Load tests need the app/operator volume.
- **Ownership (§10.1, §10.2).** Owners are needed for:
  - the Cloud Hosted private link and API keys
  - per-app instrumentation
- **Customer message.** Should a known issue carry an approved message agents can insert? If so, who approves it? This is not in v1 unless decided.
