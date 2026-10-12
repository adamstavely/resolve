# Banner broadcasting — first release

Confirmed owner scope: send banners to all registered applications or selected registered applications.
Authors select registered applications. Announcements use the Everyone audience and appear on
the portal, the application embed, or both.

## Authoring flow

1. Open Announcements → New banner; choose standard kind/style, write plain text, optionally add a safe
   link, and preview. All banners remain dismissible; preserve existing Quackback banner behavior.
2. Choose **All registered apps** or **Selected apps**. Search/select by application name/environment,
   show each app's support-instance binding and readiness, and make the current selection count explicit.
3. Choose portal, embed or both, plus publish now/schedule and optional expiry. Embed delivery requires
   the banner script installed in the host app; tenant publication alone does not prove that installation.
4. Review the exact recipient list, environments, surfaces, timing and unresolved delivery prerequisites.
   Server checks publisher authority per app. Never silently reduce “All apps” to the subset with tokens.
5. Publish the reviewed revision. Display per-app pending, succeeded, failed or uncertain results,
   with actionable reconnect/configuration messages and an aggregate partial-delivery state.

## Recipient semantics (proposed defaults)

“All registered apps” snapshots the registry at confirmation. Apps registered later do not automatically
receive an already approved broadcast; an explicit new delivery selection is required. Scheduled
broadcasts use the same fixed recipient snapshot. Store registry/binding revisions with the intent.

Include unready/suspended/unbound apps visibly in review rather than silently omitting them. Explain why
publication cannot proceed there. Operator may repair prerequisites or explicitly confirm partial delivery;
blocked apps remain recorded as not delivered. Never report success for a skipped target. Do not publish
to a replacement instance automatically if a binding changes after confirmation; require re-review.
These edge-case defaults require product acceptance before implementation, not a new definition of “all.”

## Delivery contract

Resolve backend uses the human's per-tenant grant; Quackback enforces announcement permissions and
transactional audit. Missing announcement tools are first-release Quackback prerequisites.
Create durable intent and one delivery row per app, with stable broadcast ID, payload revision/hash,
recipient binding and idempotency key. Pin the payload before dispatch. Retries use the same identity;
changed content creates a new revision and cannot reuse a key for another payload.

Bound fan-out; errors in one app do not roll back successful apps. Timeout after dispatch is uncertain,
not failed. Reconcile by tenant operation/broadcast ID before retry; one revision produces one tenant
mutation/audit even after worker failure. Store each tenant announcement ID and audit correlation.
State “published to Quackback,” not “seen by employees.” Actual rendering depends on surface configuration,
schedule, viewer session, banner priority/dismissal and the host embed installation.

Editing, ending or archiving a fleet banner fans out to its original delivery records using version checks;
show local-edit conflicts rather than overwriting them silently. Define scheduled cancellation per target:
completed publication may require archive, not cancellation of the original job. Preserve audit history.

## First-release acceptance

- All-app selection and selected-app selection publish only to the reviewed tenant bindings.
- A newly registered app cannot join an in-flight/scheduled recipient snapshot silently.
- Unbound, suspended, unauthorized or disconnected apps remain visible with accurate delivery state.
- Duplicate submits/retries and crashes after tenant commit create no duplicate announcement or audit.
- Everyone-only portal/embed content renders with the agreed styles and dismissal behavior.
- Missing embed installation is distinguished from publication success.
- Observer is denied; author identity is preserved in Resolve and every affected tenant.
- Scheduling, expiry, edit/archive and partial failure are tested across two or more tenants.
- Recipient picker, preview, confirmations and live delivery results pass WCAG 2.2 AA checks.
