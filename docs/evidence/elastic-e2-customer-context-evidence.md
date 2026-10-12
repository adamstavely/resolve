# Elastic E2 evidence: customer context and evidence snapshots

Status: 2026-10-12. E2 from [plan 14](../../plans/14-elastic-implementation.md), built against the mock Elastic and mock tenants. The fork doesn't
expose verified customer ids yet (QB-OBS-1), and no real application sends `user.id`, so real customer context waits on both.

## What exists

**Customer identity (QB-OBS-1)**
- **Lookup:** `get_customer_identity` is read with the person's own grant. The tenant also re-checks that this person can see the ticket or conversation; a hidden or invented item is "not found" before Elastic is asked anything.
- **Verified ids only:** a customer identified any other way is "unverified" and gets service-level context.
- **Tool not advertised:** the item is still checked through `get_ticket`/`get_conversation`, and the status is "not reported".

**Customer context** (`GET /api/apps/{app}/tickets|conversations/{id}/observability`; `observability.subject` plus the item's read capability)
- **Events:** the customer's APM and RUM events over 24 hours, scoped by the app mapping's services, environment and discriminator.
- **Synthetics:** the latest result per location.
- **Last session:** the region from browser monitoring.
- **Known issues:** each lists the criteria that matched and those that weren't established, plus how many of this customer's errors fall inside the issue's window.
- **Caching:** results are cached for 60 seconds per app, mapping revision and customer.
- **Restricted detail:** trace ids, transaction ids, Kibana trace links and redacted log lines are returned only to `observability.restricted`, and those reads are audited separately (`observability.restricted_read`).

**Console: System context** (beside every ticket and inbox conversation; prototype board 1)
- **Layout:**
  - customer header with "matched on user.id …"
  - amber known-issue banner with "Link to case …" (tickets)
  - facts strip: service health, errors and events in 24 hours, last session, known issues
  - "What the systems saw" (APM + RUM · last 24h) beside "Is it us?" (SYNTHETICS)
  - Recent activity with "Customer + systems / Customer only"
  - the log-lines panel for investigators, or the dashed lock box for everyone else
- **Refresh:** every 60 seconds while visible.
- **Corrections:**
  - "Very likely not specific to this account" became "That points to the service, not this account. It does not rule out a problem with the account itself."
  - The affected count is labelled approximate.
  - An event inside an issue window is described as being inside the window, never as caused by the issue.
- **Not built:** account facts (balance, KYC), Quick actions, "Copy customer message" and ML log patterns (E4). These need application APIs, the account-action executor or an approved message source.

**Evidence snapshots** (`POST …/evidence` with `observability.link`; `GET /api/evidence/{id}`; console `/evidence/{id}`, prototype board 4's evidence section)
- **Content:** numbered facts with their sources (service health at capture, customer events against issue windows, last session, restricted detail, already tried), plus a record panel (completeness, classification, hash and its check, expiry, internal note, previous revision).
- **Immutable and keyed:**
  - Snapshots are immutable (database trigger) and keyed by request id. A refresh is a new snapshot pointing at the previous one.
  - The internal note is posted as the person through the existing keyed note operation; it carries a link and a one-line summary, not the evidence.
- **Viewing:**
  - **Access:** re-checked with the tenant every time. Someone who can't see the item gets "not found".
  - **Restricted items:** counted, not shown, for anyone without `observability.restricted`.
  - **Hash:** recomputed on every view; tampering shows as "Does not match its hash".
- **Export:** JSON, for investigators only.
- **Retention:** 30 days (proposed), with a hold flag.

**Also**
- **Investigator user:** Ivy Investigator in the mock IdP (`resolve-investigators` group, mapped to `observability-investigator` in `.env.example`).
- **Redaction:** the token rule no longer re-redacts an already-replaced value, and card numbers keep their surrounding spacing.

## Exit criteria (plan 14, E2)

| Criterion | Evidence |
|---|---|
| Customer A/B and app A/B isolation | Subject queries filter on the verified id plus the app mapping's services and discriminator (`elastic.unit.test` › payroll's cust-1 vs HR's cust-1, staging excluded); `evidence.spec` › Bo (billing team) can't read a support-team ticket's context or its snapshots |
| A missing identity falls back safely | `evidence.spec` › customer 7: "did not identify this customer, so only service-level context is shown"; no customer events |
| Accurate sampling and approximation labels | Coverage note on every panel; the affected count is labelled approximate; window and "inside an issue window" wording |
| Reproducible snapshots | `observability.unit.test` › hash re-verified on view; tampering detected; restricted items hidden and counted. `evidence.spec` › "Unchanged since capture" |
| No duplicate note after a lost response | The note uses the keyed operation path (operation key = note id) with tenant replay and reconciliation, as for chat notes |
| Restricted access | `evidence.spec` › agent: no trace ids, lock box, export 403. Investigator: trace ids, Kibana links, redacted logs (no token or card), export 200; agents see that investigator's snapshot with restricted items hidden. Observer: no panel, API 403 |
| WCAG 2.2 AA | axe on the ticket with System context and on the evidence page |

Full run on 2026-10-12:

| Suite | Result |
|---|---|
| Typecheck and console build | Clean |
| Unit | 250 passed |
| Database | 71 passed |
| Contract | 32 passed |
| Browser (Chrome, one worker) | 83 passed |

## Not yet done

- **Fork and apps:** QB-OBS-1 in the fork, and per-app `user.id` instrumentation.
- **Region mapping:** "near the customer" isn't computed. The last session region is shown next to every location's check, because no mapping from regions to synthetic locations exists.
- **Owner approval:** snapshot retention (30 days) needs approval.
