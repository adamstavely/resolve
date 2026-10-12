# Elastic E3 evidence: pre-flight checks and verified receipts

Status: 2026-10-12. E3 from [plan 14](../../plans/14-elastic-implementation.md), built on the owner's instruction after E2, against the mock Elastic
and mock tenants. Plans 00 and 12 had deferred E3 because the account-action executor and application instrumentation don't exist.
So E3 is applied to the actions Resolve already performs:
- **Pre-flight:** before closing a ticket or a conversation.
- **Receipts:** for replies, notes and status changes.

Account actions (refunds, freezes and the like) still wait for their executor; each will get its own policy and receipt expectations.

## What exists

**Pre-flight checks** (prototype board 3, left; `POST /api/apps/{app}/tickets|conversations/{id}/preflight`; `lib/integrations/preflight.ts`)
- **The checks:** a versioned policy per action (`ACTION_POLICIES`, policy v1) combines:
  - current service health (SLO burn, active alerts)
  - whether a known issue touches this customer (their errors inside the issue's window, from E2's customer context)
  - synthetic checks
- **The result:** allow, warn, block or unknown, with a conclusion. It's stored with the person, target and action, and expires after 2 minutes.
- **When a known issue affects this customer:** closing warns, and offers "Link to {case} and notify me". That links the ticket to the issue and subscribes the person; the ticket stays open.
- **Run anyway:** allowed only for an advisory warning, and only with a reason. The reason is audited (`observability.preflight_override`) and shown on the receipt.
- **Server-side gate:**
  - **Reuse:** a close request reuses the stored pre-flight only while it's fresh, unused, and for the same person, target and action; otherwise it re-evaluates.
  - **Unseen warnings:** a fresh warning the person hasn't seen can't be overridden blind (`409 PREFLIGHT_WARNING`, with the pre-flight).
  - **Binding:** the pre-flight is bound to the operation it allowed and can't be reused.
  - **Permissions:** nothing overrides them; the tenant still decides.
- **Unknown:** an unidentified customer or unknown health gives "unknown". Closing is low impact, so it may go ahead (`refuseUnknown: false`).
- **Notify on clearing:** "Notify me" subscriptions (`issue_subscriptions`). When the issue stops being active, Home's Known issues panel says "Cleared: … Nothing was re-run", links back to the item, and can be dismissed. Clearing never re-runs an action.

**Verified receipts** (prototype board 3, right; `GET /api/operations/{id}/receipt`; console `/receipts/{id}`)
- **Stages, each with its source:**
  1. "Recorded in Resolve's audit" (which shows logging, not that it happened)
  2. "Accepted by the application"
  3. "Record confirmed by the application" (with the tenant's record)
  4. Where an expectation is defined, the downstream signal. For replies: "Notification accepted by the mail relay", found in telemetry by the operation id the application carries (fork gap QB-OBS-2; the mock tenants emit it).
- **Wording:**
  - A relay accepting the email is described as such, never as delivered to the inbox.
  - No match within the watch window is "sent; delivery not seen", not a failure, and late evidence upgrades it.
  - A relay failure (HTTP 550 in the mock) shows as failed.
  - Actions with no downstream expectation say so.
- **Watcher:** the integration worker looks for evidence every 5 seconds, with one Elasticsearch query per app. The receipt page re-reads Resolve, never Elastic, while it waits.

**Live activity** (prototype board 2; `GET /api/observability/activity`)
- **Content:** recent actions across the console, with "✓ verified in logs", "awaiting confirmation" or "not seen downstream".
- **Privacy:** your own actions link to their receipts; other people's actions show who, what and where, but not the target.

**Data:** migration 0010 adds `action_preflights`, `action_receipt_observations` and `issue_subscriptions`.

## Exit criteria (plan 12 §9, E3)

| Criterion | Evidence |
|---|---|
| Acceptance never masquerades as downstream success | `receipts.spec` › the reply receipt is "sent" until the relay's event is seen, then "handed to the mail relay", with "does not prove it reached the inbox"; a relay failure shows as failed; a status change says no downstream signal is defined |
| Expired evidence requires a recheck | The gate re-evaluates when the pre-flight is missing, expired, used, or for another person, target or action; `receipts.spec` › a blind override is refused with the fresh pre-flight |
| Ambiguous writes reconcile rather than duplicate | Unchanged keyed operation path; a pre-flight binds to one operation only |
| Warnings and overrides are explainable and audited | `observability.unit.test` › policy decisions; `receipts.spec` › the reason is required, audited and shown on the receipt |
| Incident-clear subscriptions notify without re-running | `receipts.spec` › the case closes, then "Cleared: … Nothing was re-run", with a link back; the ticket stays as it was |
| WCAG 2.2 AA | axe on the dialog (focus starts on the safe choice and returns to the control that opened it; Escape keeps the item open), the receipt and the ticket page. Inline links are now underlined (1.4.1) |

Full run on 2026-10-12:

| Suite | Result |
|---|---|
| Typecheck and console build | Clean |
| Unit | 252 passed |
| Database | 71 passed |
| Contract | 32 passed |
| Browser (Chrome, one worker) | 88 passed |

## Not yet done

- **Account actions:** policies, high-impact "refuse on unknown", and receipt predicates for each action, once the executor exists.
- **QB-OBS-2:** apps must carry `labels.resolve_operation_id` into downstream telemetry. Without it, receipts stop at "confirmed by the application".
- **Customer messages:** "send the known-issue message" (board 3) still needs an approved message source.
- **ServiceNow:** change-window restrictions in pre-flight wait for plan 13.
