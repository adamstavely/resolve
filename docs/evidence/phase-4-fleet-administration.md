# Phase 4 evidence — fleet administration and onboarding

Status: 2026-10-12. Built and tested against the development mock fleet and mock fleet worker
(`tools/mock-tenant/worker.mts`), which implement the target worker contract (contract 4). The Quackback fork has
no Resolve-facing worker or registry projection yet (QB-REG-1); the real worker, ingress admission and AWS adapter are
fork and infrastructure work.

Owner decisions applied (plan 05, plan 07):
- One instance per application and environment.
- Both create and adopt in v1.
- Chat, SSO and inbound email are required at activation.
- Support hostnames are entered freely, but only under the approved support domains (`SUPPORT_DOMAINS`).

## What exists

- **Data model** (migration 0006):
  - `applications` (stable key, owner, support team).
  - `instance_bindings`: one per application/environment, a unique workspace key and hostname, and Resolve's lifecycle
    (draft → onboarding → ready → active → suspended → retired).
  - `onboarding_runs`: saved steps, the reviewed configuration and its revision, and optimistic versioning.
  - `fleet_jobs`: request id, per-app lock, monotonic desired-state version, stage, checks, evidence and failed stage.
  - `app_team_mappings`.
  - `user_entitlements`, plus leased and fenced `entitlement_jobs`.
  - `pilot_checks`.
  - Resolve stores no tenant DSN, database credential or worker secret.
- **Onboarding wizard** (`/applications/onboarding/…`, `apps/api/lib/fleet-admin/onboarding.ts`):
  - **Steps:** describe, instance (create or adopt), support and access (team mappings and named pilots), entry points
    (the required inbound email and the optional banner), review, validate, and activate with hand-over.
  - **Drafts:** each step is a server-side draft, so a run resumes after sign-out or failure.
  - **Errors:** each refers to the field at fault and moves focus there.
  - **Duplicates:** a duplicate key, address, binding or open run is refused, pointing to the existing record.
    "Add an environment" reuses an existing application.
  - **Review:** fixes a configuration revision. Any later edit clears it, so old validation and pilot evidence can never activate a changed configuration.
  - **Adoption:** review shows a read-only impact report covering settings now, after adoption, and against central policy.
    It also shows which existing people become managed (only holders of a mapped bundle); everyone else is unchanged.
- **Privileged jobs** (`apps/api/lib/fleet-admin/jobs.ts`, `worker-client.ts`, `scripts/fleet-jobs.mts`):
  - **Intent first:** every command is recorded, then dispatched with a request id. Resolve and the worker both dedupe on it,
    so double clicks, refreshes, concurrent submits and lost responses are one job.
  - **Locking:** one lifecycle job runs per app (database lock and worker lock), and desired-state versions only increase.
  - **Audit:** every stage change is audited (`app.job.*`).
  - **Resume:** a failed job resumes from the stage that failed, with exactly the same parameters, and needs the same capability.
  - **Cancel:** further stages stop; created resources are kept and reported, never deleted.
  - **Dispatcher:** dispatches anything that never reached the worker, follows running jobs, and drains the entitlement queue.
- **Maintenance-only validation and pilots:**
  - **Created instances:** wait in maintenance. The tenant admits only pilot identities, and Resolve's registry overlay keeps
    every app with an unfinished binding closed to agents (an adopted instance keeps serving its own users meanwhile).
  - **Validation checks:**
    - database identity, migrations and receipts, templates
    - SSO sign-in and linking
    - mappings that give the pilots staff access
    - Resolve's OAuth client, secret canary, storage
    - chat, inbound email, the optional banner
    - negative probes: anonymous, observer and denied writes are refused
    - normal ingress blocked
  - **Pilot check:** a real, named pilot connects through SSO, reads the queue and adds an internal note as themselves,
    as a recorded operation attributed to them in Resolve and the tenant. Nothing is simulated.
  - **Activation:** needs validation evidence and a passed pilot check for the current revision. The worker refuses
    an activation whose revision or image differs from what was validated.
- **OAuth client without a shared secret:** Resolve generates its tenant client secret and keeps it sealed. The worker gets only
  its SHA-256, so no secret appears in a job, a log or an audit summary.
- **Team mappings and entitlements** (`entitlements.ts`):
  - **Computing the role:** a person's tenant role is the highest role their bundles map to, and their teams are combined.
    An unmapped bundle gives nothing.
  - **Who is managed:** people who drop out become portal users, not lingering staff. Unmanaged people are untouched.
  - **When it's recomputed:** mapping changes, sign-in (bundles from IdP groups), manual blocks and directory disables.
    Each change makes a new desired version and one job.
  - **Workers:** they claim with a lease and a fresh fencing token, skip superseded versions, and back off retries.
    A stalled worker's late result is fenced off.
  - **Tenant side:** an older version never replaces a newer one, the same version with a different payload is refused,
    and a denial blocks tool calls and token refresh.
- **Lifecycle:**
  - **Suspend:** confirmed, with a reason. The fleet stops routing, ends open long polls and refuses calls.
  - **Resume:** restores access without reconnecting. It's refused for an instance held back on an older image.
  - **Migration status:** per-instance image, applied/pending migrations, receipts and readiness against the fleet's target image.
- **People and roles** (`/people`): bundles with their capabilities, the IdP groups that grant them, and holder counts.
  Search people, grant or remove manual bundles with a reason, and apply or lift emergency blocks.
  Changes take effect on the person's next request and reach mapped applications as entitlements.
- **Audit categories:** onboarding, jobs and mappings under App administration; bundle changes under Access changes;
  propagation under **Entitlement sync**.
- **Capabilities** (plan 07, decision 3: admins hold all three):
  - `app.register` for drafts and review
  - `app.provision` for provision, validate and resume
  - `app.activate`
  - `app.lifecycle`
  - `roles.manage`

  Pilots need only `connection.manage`.

## Exit criteria (plan 00)

| Criterion | Evidence |
|---|---|
| Maintenance-only validation before activation | `onboarding.spec` › the wizard test: while validating, Sam (not a pilot) cannot connect; activation is refused (`PILOT_REQUIRED`) until a pilot passes; then Sam connects and reads. The checks include `ingress.maintenance` and the negative probes |
| Version-fenced role jobs | `onboarding.spec` › role changes reach the tenant…: mapping change and block/unblock each raise the tenant's version and the denial is enforced. `fleet-admin.db.test` (reclaimed lease fences the stalled worker; a late older result never lowers the applied version; superseded jobs). `fleet-worker.unit.test` (older never replaces newer; one version, one payload; forged payload hash refused) |
| Suspended-tenant recovery | `onboarding.spec` › suspending an instance…: the agent is refused while suspended and recovers on resume without reconnecting; both jobs are audited |
| No root/DSN credentials in Resolve | Strict job schemas (unknown fields refused anywhere: `fleet-worker.unit.test`, `wire.unit.test`). The worker validates again. Only a secret hash is sent. The stored run is checked for DSN or secret text (`onboarding.spec` › repeated dispatch…). Resolve's config holds the worker URL and a service token only |
| Failed jobs resumable without broadening access | `onboarding.spec` › a failed stage resumes…: an injected failure at *migrating* resumes from *migrating* as the same job; later edits need re-review, re-provisioning and a new pilot check. Resume needs the command's own capability |

Further evidence:
- **Idempotency:**
  - concurrent and repeated dispatch is one job and one instance (`onboarding.spec`, `fleet-admin.db.test`);
  - the worker dedupes on request id and refuses a changed payload (`fleet-worker.unit.test`).
- **Adoption:** the impact report flags settings that differ from policy without changing them, and only holders of a mapped bundle become managed (`onboarding.spec` › adoption…).
- **Access:** non-admins get 403 from every administration route (`onboarding.spec`); manual bundle grants are audited with their reason and change capabilities at once (`onboarding.spec` › people and roles).
- **Accessibility:** axe (WCAG 2.2 AA) passes on the wizard's describe, review and validate steps, adoption review, app admin and people pages.

## Found while building

- **Activation lag across processes:** the job dispatcher settles jobs in its own process, so the API's cached registry could show an
  activated or suspended app in its old state for up to 30 s.
  - **Fix:** the registry overlay now compares binding changes with the cache time and rereads the fleet, and a lookup miss rereads once.
- **Retry starvation:** retried entitlement applies kept their original order and starved newer work. They now back off (`not_before`).
- **Retrying a known request id:** a retry resubmitted a request id the worker already had, which only returned the failed job.
  - **Fix:** retries now resume the worker's job.
- **Audit crowding:** propagation events crowded the "Access changes" audit view, so they now have their own category.
  Viewing and typing signals moved to the availability category for the same reason.

## Not yet done

- **Real worker and fleet:** the fork-built worker, maintenance-only ingress admission, AWS adapter and DNS (plan 03).
  Real migrations and receipts (PR24 primitives), template reconciliation, and crash tests at every stage boundary.
  The mock resumes and dedupes but does not survive its own restart.
- **Mail:** a real inbound mail test and spool (plan 03 "Mail").
- **Deprovision and retire:** this stays a separately authorized workflow, as the plans intend. Cancellation retains created instances.
- **Directory-driven bundle changes:** bundles from IdP groups refresh at sign-in; a group change without a sign-in waits until then.
- **Cross-environment views:** one application with production and test bindings is modelled. The list shows both;
  promotion between them is not a workflow.
- **Fork requirements:**
  - tenants must accept versioned entitlements keyed by IdP issuer/subject (plan 02);
  - tenants must drop availability and sessions on denial;
  - an admission mechanism must let only pilots through while an instance is not routable.
