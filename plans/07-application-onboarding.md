# Application and Quackback-instance onboarding

Status: proposed workflow, 2026-10-12. Planning only. Onboarding is a fleet-administration capability;
its prerequisites must be available before the wizard is released. No infrastructure is created by this plan.

## Model: two related records

A supported application (for example Payroll) is not its Quackback workspace. Register the business
application first, then attach its support instance. Store:

- Application: stable ID/key, name, description, application URL, environment, accountable owner,
  support team, lifecycle status and contact. URLs must use approved internal domains.
- Support-instance binding: application ID, environment, immutable Quackback workspace key, canonical
  support hostname, connection/protocol version, provisioning operation ID and readiness evidence.
- Onboarding run: immutable request ID, saved step data, initiator, desired configuration revision,
  current stage, validation results and append-only audit history.

Proposed v1 cardinality: one support instance per application/environment; an instance cannot belong to
several application/environment records. Production and test are separate bindings and credentials.
Enforce uniqueness server-side. Renaming an application never renames a workspace key or breaks URLs.
Confirm shared-instance/multiple-board use cases before relaxing this boundary.

Application registration is distinct from connecting its business APIs for account actions. Such APIs
are optional and governed by Quackback plan 40's enablement/conformance requirements. Registering an app
must not automatically authorize account actions or silently enable optional features.

## Operator experience

Entry: Applications → Register application, available only with the app-registration capability.
Show a persistent checklist, owner and current status. Save drafts; resume safely after logout or failure.

### 1. Describe the application

Name, short description, stable key suggestion, application URL, environment, application owner and
support owner/team. Check duplicate URLs/keys/bindings and offer the existing record rather than creating
another one. Explain that the support hostname is separate from the application URL.
Exit: a draft application record, not a live tenant or a DNS change.

### 2. Choose the support instance

- **Create a new managed instance:** propose an approved support hostname and mail slug. Resolve queues
  the privileged Quackback provisioner through the versioned command interface.
- **Register an existing managed instance:** select from the authorized unbound fleet registry and prove
  its identity/version. Resolve never accepts a pasted tenant DSN, root key or arbitrary bearer token.
- **Existing instance outside this fleet:** separate discovery/import assessment, not automatic adoption.
  Check tenancy mode, data ownership, migrations, secrets, identity mapping and supported integration.
  Do not move data, rewrite roles or change authentication as a side effect of “Test connection.”

Existing data/roles require a reviewable before/after impact report before Resolve takes management.
The operator explicitly chooses managed principals; existing unmanaged people remain untouched.

### 3. Configure support and access

Inherit centrally managed defaults and show their source: company SSO provider, public-at-Quackback
portal behind intranet SSO, anonymous actions disabled, widget HMAC, branding, default support features,
and Everyone-only announcements. No passwords or identity secrets entered into the wizard.

Choose app-specific support owners, Resolve role bundles and explicit per-app tier-team mappings where
tiers are supported. Show resulting permissions and missing mappings; missing mapping grants nothing.
Do not create reserved Tier roles unless the prerequisite feature and template versions are installed.
Include a non-tower-managed break-glass admin/recovery setup through the approved secure operations flow.

Show capabilities as available, requires prerequisite, or intentionally off. Dependencies cannot be enabled
by toggling a disabled control. Portal/hub and chat retain their existing Quackback feature gates and domain rules. Feedback, roadmap, changelog and account-action configuration are not first-release Resolve workflows; preserve existing tenant settings without exposing new controls for them.

### 4. Configure entry points

Review support URL and navigation destination. Optionally configure inbound support email and banner
installation. Everyone banner snippet is generated only for the bound instance, with CSP/edge guidance;
Host-app deployment remains an explicit task owned by that app's team.

Mail setup records ownership, trusted routing/header readiness and test outcome. No email setup means
“email unavailable,” not a fictional working address. A required channel must pass before activation;
optional channels can remain disabled with a visible follow-up checklist.

### 5. Review and provision/connect

Show application/environment, support hostname, tenant strategy, owners, feature selection, grants,
required infrastructure changes and channel readiness. For adoption, show changes to existing settings
and managed roles separately. Confirm dispatch of the exact reviewed configuration revision.

Queue an idempotent operation. The UI displays stage progress and redacted errors without blocking the
browser request until provisioning ends. Refreshing or double-clicking cannot create a second instance.
Configuration edits during execution create a new revision and invalidate earlier validation results.

### 6. Validate while non-routable

The worker uses the maintenance scope and maintenance-only probe ingress from plan 03. Validate database
identity, upstream/fork migrations and receipts, catalogue/template reconciliation, SSO and account linking,
role mappings, human OAuth client, secret canary, storage namespace and required channels.

Exercise a real authorized pilot user: SSO, portal, Resolve connection, read and permitted action with
human audit, plus observer/anonymous/denied-user negative tests. Do not fabricate sign-in/test evidence.
A pilot can reach only the restricted validation ingress; normal traffic and workers remain blocked.

Readiness is bound to image/protocol, settings and entitlement versions. Stale evidence cannot activate.
A failure keeps the app non-routable, presents a clear repair action and preserves completed stages.

### 7. Activate and hand over

After all required checks pass, an authorized operator activates the tested revision. The worker enables
normal routing through the checked activation transition; do not mark active before running probes.
Show support URL, dashboard link, channel state, installation snippets, accountable owners and runbook.

“Instance ready” is distinct from “connected for this operator.” OAuth grants remain per-human/per-app;
provisioning does not grant all Resolve users access or create their personal tokens. Eligible users
connect through the no-consent SSO flow, with interaction if the IdP requires it.

## State and recovery

Application lifecycle: draft → onboarding → ready → active → suspended → retired.
Binding/job stages are separate: requested, preparing, migrating, reconciling, validating,
ready_to_activate, activating, succeeded, retryable_failure, needs_operator, cancelled.
“Ready” means required checks passed without making the instance public to normal intranet traffic.

Per-app operation lock, durable idempotency key, configuration hash and worker fencing prevent duplicate
execution. Replays return the same job and resource identities. Reconcile resources after an unknown AWS
response before retrying create. Cancellation stops undispatched stages; it does not promise rollback of
already-created resources. Quarantine partial tenants and report retained resources. Never automatically
delete an adopted instance or populated database. Cleanup/deprovision is a separately authorized workflow.

Role/application metadata writes are Resolve-owned; tenant configuration goes through Quackback's worker
or supported APIs. No wizard-only validation replaces server validation. Secrets are generated/stored by
the privileged worker and never returned in job payloads, logs, browser URLs or audit summaries.

## Accessibility and operator feedback

Step headings and progress have accessible names; validation errors are associated with their fields and
summarized with focus management. Preserve entered data on errors and session reauthentication. Announce
stage changes politely without moving focus or reading every log line. All steps, confirmations, retry,
copy-snippet and cancellation actions work with keyboard and screen readers. No drag-only ordering.

## Acceptance scenarios

- New application + new instance completes with one binding and tenant, even after repeated submits.
- Existing unbound instance connects without silently modifying data, authentication or local roles.
- Cross-app/duplicate binding and unauthorized registry selection fail before mutation.
- Missing team mapping, incompatible tenant version or required channel failure blocks readiness.
- Crash at every stage, including after infrastructure commit, resumes without duplicate resources.
- Changed configuration after validation requires revalidation; normal traffic cannot bypass maintenance.
- Pilot OAuth is tied to the correct human/app; another employee gets no inherited token.
- Successful action is attributable to the pilot human in both Resolve and Quackback.
- Cancellation/adoption failure preserves existing data and reports partial resources.
- Full wizard passes WCAG 2.2 AA verification across loading, error, recovery and success states.

## Decisions to settle before implementation

1. ~~One instance per application/environment, or shared?~~ Decided 2026-10-12: one per application/environment.
2. ~~Create and adopt, or create only?~~ Decided 2026-10-12: both in v1. Adoption shows an impact report first.
3. ~~Who may register, provision and activate?~~ Decided 2026-10-12: admins, and one admin may hold all three.
4. ~~Mandatory channels at activation?~~ Decided 2026-10-12: chat, SSO and inbound email must pass; the banner snippet is optional.
5. ~~Naming conventions?~~ Decided 2026-10-12: free entry, with the hostname restricted to the approved support domains. The owner confirmed the onboarding wizard and all-app/selected-app banner broadcasts as first-release requirements alongside dashboard and operator actions.
