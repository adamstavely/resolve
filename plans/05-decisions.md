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

- Initial-release operator workflows are limited to chats and tickets. Feedback, roadmap and changelog views/actions are excluded, including feedback triage/merge and changelog publishing.

## Proposed defaults, not newly confirmed decisions

- Onboarding and the administration controls it requires are first-release scope; portfolio is later.
- PostgreSQL/Drizzle and auth provider choice remain subject to validation.
- Quackback-dependent provisioner/mail workers stay in Quackback; Resolve calls versioned contracts.
- One serving image; suspended tenants for held-back upgrades. No active multi-version cohort routing.
- Revocation target 15 minutes; optional entitlement lease off until the outage/access tradeoff is accepted.
- Per-app team mapping fails closed; no mapping means no tier grant.

## Owner/infrastructure inputs (one question per line)

1. Should unread state follow Quackback’s shared support-team watermark (proposed), or does Resolve require personal unread state per SRE?
2. Which IdP/directory product will provide SSO and authoritative group/user changes, and can we use its directory API as well as SCIM?
3. Is a 15-minute revocation target acceptable during normal operation, or is a request-enforced entitlement lease required even if a directory outage locks out managed users?
4. Can held-back Quackback tenants be temporarily suspended during upgrades, or must different versions keep serving concurrently?
5. What internal DNS domain, private CA, edge SSO product and AWS region/environment should the deployment plan target?
6. Who owns the internal mail service, and can it supply a catch-all mailbox with trustworthy per-recipient routing headers and an agreed queued-mail retention period?
7. What initial app count, simultaneous operator count and expected daily ticket/broadcast volume should capacity tests use?
8. What retention and access requirements apply to operator audit records, directory events, encrypted grants and dead-letter mail?

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
