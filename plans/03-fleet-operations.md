# Fleet operations and deployment

## Privileged execution boundary

The fork-built Quackback worker owns database creation, tenant identity validation, seeding, role apply,
mail delivery and resume. Resolve owns durable command intent and progress. Use an allowlisted task
definition and narrow pass-role/dispatch permissions; validate requests again inside the worker.
Operator identity and request ID must survive dispatch and appear in audit. Prevent duplicate destructive
jobs; deprovision requires a separate retention/recovery design and is not a first-release control.

## Adopt existing migration readiness

Baseline Quackback main 562a6b1de includes PR24: `fleet-migrator fork`, hash-based catalogue receipts,
`missingForkRequirements` and serving-path readiness. Reuse these primitives rather than introducing
independent integer catalogue truth. Template/managed-role reconciliation may require an additional
versioned receipt, but it must have a distinct purpose and must not claim the existing seed receipt
certifies template or identity reconciliation.

Phase 0 must inventory which parts actually exist; maintenance scope and Resolve orchestration are planned.
Default one serving image per fleet. Migrate active tenants to the whole new image bundle before rolling.
Held-back tenants remain suspended. Do not implement the old speculative behind-upstream fork-only path
without an explicit new requirement and compatibility proof. The implemented fork command refuses missing
bundled upstream migrations. Suspended tenants need direct maintenance handling, not ordinary serving scope.

## Create/resume state machine

Control operation stages: requested → preparing → migrating → reconciling → validating → ready_to_activate
→ active; errors remain non-routable and retain resumable stage evidence.

1. Reserve app key and operation id under a per-app lock; create or verify infrastructure idempotently.
2. Keep public/normal hostname routing disabled. Open an unpooled maintenance connection, verify tenant
   identity, fingerprint, physical identity and secret canary without requiring serving eligibility.
3. Run approved upstream/fork migration and seeding path under its existing lock. Reconcile templates,
   desired roles/denials, SSO baseline and storage. Write each completion receipt only after work commits.
4. Validate with the real application handlers using a maintenance-only ingress accessible to the probe
   identity. Normal requests, workers and edge traffic remain denied. Do not flip registry to active merely
   to make HTTP probes possible. Implement and test this narrow admission mechanism in Quackback/ingress.
5. Probe SSO-only login, anonymous write denial, denied users, storage, tool authorization and edge SSO.
   Pin the tested image, settings revision and desired-state version.
6. Activate atomically against that tested version; if configuration changed, invalidate readiness and probe
   again. Publish normal routing only after all gates pass. A reaper cleans abandoned operations but is not
   what prevents premature exposure.

Crash tests at every boundary must show either non-routable maintenance or a fully validated active app.
Suspension needs explicit connection/cache invalidation and background-worker exclusion, not just a registry
row update; verify actual upstream cache lifetime and existing streams in phase 0.

## Intranet baseline

Public portal at Quackback level behind authenticated intranet ingress; anonymous actions off; sign-up
closed except intended SSO JIT; password/social/email fallback paths explicitly controlled; widget HMAC.
Internal DNS and trusted private CA; no TLS-verification bypass. Keep break-glass access narrowly documented.
Validate email OTP behavior, real SAML broker/OIDC login and first-party consent skipping on selected versions.
Internal endpoints need a narrowly scoped SSRF allow-list; metadata/link-local/loopback remain blocked.
No runtime public internet connections, CDN resources or silent telemetry. Build dependencies via approved
build network/mirrors. IAM/static credential choices require the real AWS adapter spike.

## Mail

Retain raw-message polling/spooling in the Quackback worker, not the Resolve web process. Trusted envelope
headers must be stripped and stamped by the mail system; no sender-controlled To/Cc fallback.
Known suspended tenant → queued delivery, retry after activation, retention deadline and operator alert.
Unknown or deleted recipient → dead-letter with reason. Suspension must not terminally discard valid intake.
Receiver-side dedup must cover missing/oversized Message-ID and accepted-before-ack crashes; current
upstream dedup behavior needs a verified adapter/receipt contract before claiming exactly-once visibility.
Use persistent spool and delivery records, bounded retries, poison-message handling and replay audit.
Define retention, mailbox ownership and redrive policy with operations before enabling the router.

## Releases and recovery

Pin Resolve image, worker image and supported tenant protocol range. Deploy additive contract/schema changes
before consumers. Keep old/new overlap tests and feature gates. Backups are managed cluster/PITR plus fleet
object-store recovery; rehearse mapping, token invalidation and replay behavior after restore. Do not assume
restored encrypted OAuth tokens remain valid. Reconnect is the safe recovery path when uncertain.
