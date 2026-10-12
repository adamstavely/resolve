# Decisions, assumptions and outstanding inputs

## Confirmed from the owner

- Name: Resolve. Separate repository: adamstavely/resolve. Planning before implementation.
- Tenant product remains the adamstavely/quackback fork, tracking upstream releases.
- Internal intranet and SSO only; no runtime public internet egress.
- Human attribution for actions; privileged provisioning separate from the tower runtime.
- Shared managed PostgreSQL infrastructure and fleet storage; retain tenant isolation.
- Tower owns the entire role set for tower-managed principals; directory disablement must deny tenant access.
- Portal and application-embed announcements use the Everyone audience.
- Internal LLM proxy/Bedrock if AI is introduced; Resolve's initial scope does not require new AI features.

- First-pass dashboard KPIs: open/unassigned tickets, awaiting response, SLA breached/approaching deadlines and recent activity. Exact definitions/API prerequisites are in document 11.
- SREs receive and handle Quackback chats entirely in Resolve; the unified live inbox is first-release scope.
- First release includes fleet dashboard, operator actions, application/instance onboarding, and banners to all registered apps or selected registered apps.
- Backend: Next.js running on Node.js. Frontend: Angular, with Web Components throughout.
- Use official shadcn-ui/ui React controls wrapped as Web Components; Angular owns the application. Both runtimes are explicitly approved.
- Fully leverage Quackback APIs; use Resolve’s own UI, not embedded Quackback screens.
- Full WCAG 2.2 AA frontend conformance is a release requirement.
- Use the supplied Resolve prototype and Interop style guide as design references.

- Decided 2026-10-12:
  - Everyone banners use Quackback's existing `authenticated` audience tier; portals sit behind intranet SSO.
  - Unread follows Quackback's shared support-team watermark. There is no per-SRE unread state (QB-CHAT-7 closed).
  - Admins register applications, provision instances and activate them. One admin may hold all three (plan 07, decision 3).
  - Dashboard KPI aggregates require `analytics.view` in addition to the per-entity permissions (plan 11).
  - The IdP will support both OAuth 2.0/OpenID Connect and SAML 2.0. Until the product is chosen, development uses a mock IdP.

- Initial-release operator workflows are limited to chats and tickets. Feedback, roadmap and changelog views/actions are excluded, including feedback triage/merge and changelog publishing.

## Proposed defaults, not newly confirmed decisions

- Onboarding and the administration controls it requires are first-release scope; portfolio is later.
- PostgreSQL/Drizzle and auth provider choice remain subject to validation.
- Quackback-dependent provisioner/mail workers stay in Quackback; Resolve calls versioned contracts.
- One serving image; suspended tenants for held-back upgrades. No active multi-version cohort routing.
- Revocation target 15 minutes; optional entitlement lease off until the outage/access tradeoff is accepted.
- Per-app team mapping fails closed; no mapping means no tier grant.

## Owner/infrastructure inputs (one question per line)

1. Which IdP/directory product will replace the mock, and does it offer a directory API as well as SCIM for authoritative user/group changes?
2. Is a 15-minute revocation target acceptable during normal operation, or is a request-enforced entitlement lease required even if a directory outage locks out managed users?
3. Can held-back Quackback tenants be temporarily suspended during upgrades, or must different versions keep serving concurrently?
4. What internal DNS domain, private CA, edge SSO product and AWS region/environment should the deployment plan target?
5. Who owns the internal mail service, and can it supply a catch-all mailbox with trustworthy per-recipient routing headers and an agreed queued-mail retention period?
6. What initial app count, simultaneous operator count and expected daily ticket/broadcast volume should capacity tests use?
7. What retention and access requirements apply to operator audit records, directory events, encrypted grants and dead-letter mail?

Only ask these when they affect the next work package; unresolved production inputs do not prevent refining
contracts. Do not turn proposed defaults into confirmed requirements by repeating them in later documents.

## Source and precedence

Historical plan imported from Quackback main commit 562a6b1de0b4d847d846e047a1818666e2030626,
`plans/v2/20-control-tower.md`. The reference is unchanged for traceability. This detailed plan supersedes
its monorepo location, identity uniqueness, activate-before-probe sequence, unversioned revocation queue,
old migration mechanism and terminal handling of mail for suspended apps.

Related Quackback specs remain in that repository: plans/v2/10-rbac-persona-extensions.md,
02-fork-conventions.md, 04-intranet-deployment.md, 30-tiered-support.md, 40-support-account-actions.md,
50-prioritization-scoring.md and 60-announcements-banner.md. Their existence does not imply implementation.
Use the current verified code and owner decisions to resolve contradictions; record cross-repo changes
explicitly instead of maintaining untracked copies of all dependencies here.
