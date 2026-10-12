# Resolve delivery plan

Status: proposed detailed plan; implementation has not started. Prepared 2026-10-12.

## Purpose and end state

Support teams currently need to open each application's Quackback instance separately. Resolve will
provide one SSO entry point for fleet visibility and authorized work across those instances, while
preserving tenant isolation and recording the responsible human in both systems.

An employee signs in, sees the apps and capabilities available to them, connects their per-app grants,
and gets a dashboard whose partial failures are visible. An operator can later open a ticket or
conversation, perform an authorized action, and trace the outcome to the tenant record and Resolve audit.
An announcement author can later publish an Everyone announcement to explicitly selected apps and see
success, failure or uncertain completion per app.

## Repository boundary

Resolve owns its UI, application server, database migrations, OAuth client, directory ingestion,
control-job orchestration, audit and integration contracts. It is a standalone repository and release.
It is not an `apps/control-tower` directory in the Quackback monorepo.

Quackback owns tenant application code, tenant migrations, tenant authorization, pooled registry
interpretation, provisioner and raw-mail worker code that import Quackback internals. Those workers
remain built from the fork image. Resolve invokes a versioned command interface; it never imports
Quackback source files, opens tenant databases or receives the fleet root key.

Move ownership of the tower specification here. Retain a pointer in the old Quackback plan location.
The imported reference preserves the earlier rationale and requirement IDs, but its old paths, seam
counts and assumptions must not override the active documents here.

## Scope and sequencing

Confirmed first release: fleet dashboard, operator actions, application/Quackback-instance onboarding,
and Everyone-banner publishing to all registered apps or selected registered apps.
Phases 0–6 below are delivery milestones within that release, not separate scope reductions.
Portfolio is a later extension and does not block this release. Feedback, roadmap and changelog viewing, triage, merge and publishing workflows are removed from initial-release scope by owner decision.

### Phase 0 — Integration discovery and executable contract specification

Deliver: validate Angular/Web Components/shadcn integration with accessible forms, dialogs and comboboxes; inventory existing tenant tools and permission gates; identify missing tools; record exact
Quackback commit/image and protocol versions; select supported IdP integration; threat model and
network routes; Resolve wire schemas and capability catalogue; infrastructure cost/capacity assumptions.
Validate two tenant hosts, the real edge proxy and the internal IdP in a disposable environment.
Exit: no undocumented privileged shortcut, each feature mapped to a tool and permission, identity
mapping demonstrated without email linking, provisioner API ownership agreed. No application coding
starts merely because the historical plan calls a dependency complete.

### Phase 1 — Resolve foundation and identity

Deliver later: project scaffold, internal-only deployment, Resolve schema/migration runner, SSO,
capability enforcement, app registry adapter, encrypted per-user OAuth grants, connection UI, audit,
health endpoints and directory observation ingestion. Required stack: Angular frontend composed of Web Components, Next.js backend on Node.js. PostgreSQL/Drizzle and the auth library remain proposals; versions are pinned after compatibility validation. See document 06 for component and Quackback API reuse contracts.
Exit: two apps connect as the same mapped human; wrong user/app callbacks fail; observer requests
read scopes only; session and directory revocation tests pass; no runtime internet egress.

### Phase 2 — Internal fleet-read milestone (not a standalone release)

Deliver: app list, connection/health state, first-pass KPI cards (document 11: open/unassigned tickets, customers awaiting response, SLA risk and recent activity), conversations and tickets. Feedback, roadmap and changelog views are excluded from this release. Explicit unavailable/deferred states replace fake counts.
Exit: row-level authorization holds on direct IDs; partial failures do not hide successful app results;
no app wakes merely because a dashboard periodically polls; pagination neither loses nor repeats items.

### Phase 3 — Operator actions

Deliver: unified live SRE chat inbox (document 09), including incoming chats, history, replies, notes, attachments and reconnect recovery inside Resolve; chat/ticket status and assignment actions, after each tool's field and object authorization is proven. Confirmation for destructive/bulk work.
Exit: audit correlation to the human and tenant record; uncertain outcomes visible; no automatic retry
of non-idempotent actions; tenant permissions rechecked independently of Resolve's UI.
Tier escalation/account actions retain their own Quackback plans and are not silently added here.

### Phase 4 — Fleet administration

Deliver: application registration and instance onboarding wizard (document 07), privileged command orchestration, role bundles, app/team mapping, desired-state reconciliation,
create/suspend/resume, migration status and operational audit. Revocation primitives required by phase 1
must already exist; this phase adds the administration UI, not delayed security enforcement.
Exit: maintenance-only validation before activation, version-fenced role jobs, suspended-tenant recovery,
no root/DSN credentials in Resolve, failed jobs resumable without broadening access.

### Phase 5 — Banner broadcasts (first release)

Deliver Everyone-only broadcast authoring with All registered apps and Selected apps targeting,
reviewed recipient snapshots, per-app outcomes and reconciliation by broadcast ID (document 08).
Exit: duplicate requests produce one tenant mutation/audit; observer cannot publish; unknown completion
is reconciled safely. Existing local banners do not mean the fleet broadcast API exists.

### Phase 6 — Production qualification

Deliver staging upgrade rehearsal, recovery/restore exercise, security review, accessibility verification,
load/capacity results, operational ownership and release runbook. Release gates in document 04.
No claim of production readiness or WCAG conformance follows from unit tests alone.

## Later extension — Portfolio

Portfolio read/list views follow prioritization API availability and are outside the confirmed first release.
Do not defer onboarding or banner broadcasting together with portfolio.

## Work packages and dependency tracking

Track each phase with separate issues for Resolve work, Quackback prerequisites, infrastructure and
validation evidence. Each issue records owner, dependent protocol/tool version, acceptance test, rollout
and rollback. A phase closes only when its evidence is attached. Effort estimates follow phase 0;
calendar dates and headcount are not assumed in this plan.
