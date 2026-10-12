# Resolve

Resolve is the internal control tower for the organization's Quackback fleet.
Status: **phases 0–1 done against mocks; phase 2 fleet read (dashboard, tickets, conversations) working against mocks.** The repository contains
the stack foundation (Angular console with shadcn controls as Web Components, Next.js API on Node.js,
PostgreSQL), the v1 contract specification, OIDC sign-in, per-app OAuth grants, directory revocation and audit.
There are no real Quackback tenant integrations, infrastructure or deployment yet; see the phase exit criteria in the delivery plan.

Start with [the delivery plan](plans/00-delivery-plan.md). The active specification is the numbered
planning documents here; the imported [Quackback v2 plan](plans/reference/20-control-tower-quackback-v2.md)
is a historical reference, not an implementation-ready specification.

## Development

Requires Node.js from `.nvmrc` (24.15 or later, below 25) and Docker for a disposable PostgreSQL.

```sh
npm ci
cp .env.example .env       # development-only values, including the mock IdP client
docker run -d --name resolve-db -e POSTGRES_USER=resolve -e POSTGRES_PASSWORD=resolve \
  -e POSTGRES_DB=resolve -p 127.0.0.1:55432:5432 postgres:18
npm run db:migrate
npm run dev:seed           # registers Resolve's OAuth client with each mock tenant (sealed)
npm run dev                # mock IdP :3200, mock tenants :3300-3302, directory worker, API :3100, console :4200
```

Open http://127.0.0.1:4200 and choose **Sign in**. The mock IdP (`tools/mock-idp`) lists test users
whose groups map to bundles through `RESOLVE_GROUP_BUNDLES`: Ada Admin, Sam Agent, Olive Observer,
Bea Broadcaster, a user with no groups, and "Sam Duplicate", who has the same email as Sam but a different subject.
The real IdP will be an OIDC/SAML 2.0 provider; Resolve signs in with OIDC (authorization code + PKCE).
Under **Applications**, connect to the mock Payroll, HR and Legal Ops tenants (`tools/mock-tenant`); they sign you in
through the IdP session without a second prompt. Home then shows KPIs and activity, and **Tickets** and
**Conversations** list each app's data (Legal Ops is idle until you load it). To simulate a directory change:
`curl -X POST -H "Authorization: Bearer $DIRECTORY_TOKEN" -d '{"active":false}' http://127.0.0.1:3200/dev/users/mock%7Cbea/active`.

```sh
npm run check              # typecheck, console build and unit tests
npm run db:test            # database tests (DATABASE_URL from .env or the environment)
npm run test:e2e           # Playwright + axe against npm run dev; PW_CHANNEL=chrome uses installed Chrome
QUACKBACK_SRC=../quackback npm run test:contract   # tool inventory vs. the pinned fork
```

Evidence: [component gate](docs/evidence/phase-0-component-gate.md),
[contracts and tool inventory](docs/evidence/phase-0-contracts.md), [identity and connections](docs/evidence/phase-1-identity.md), [fleet read](docs/evidence/phase-2-fleet-read.md).

`/api/readiness` reports ready only when the API has `DATABASE_URL` and the latest migration is applied.

## Planning documents

- [00 — Scope, ownership and delivery](plans/00-delivery-plan.md)
- [01 — Architecture and integration contracts](plans/01-architecture-contracts.md)
- [02 — Identity, permissions and revocation](plans/02-identity-access.md)
- [03 — Provisioning, migrations and operations](plans/03-fleet-operations.md)
- [04 — Verification and upstream upgrades](plans/04-verification-upgrades.md)
- [05 — Decisions and unresolved inputs](plans/05-decisions.md)
- [06 — Frontend, design system and accessibility](plans/06-frontend-design-accessibility.md)
- [07 — Application and instance onboarding](plans/07-application-onboarding.md)
- [08 — All-app and selected-app banner broadcasts](plans/08-banner-broadcasts.md)
- [09 — Unified SRE chat inbox](plans/09-unified-chat-inbox.md)
- [10 — Verified Quackback chat API gaps](plans/10-quackback-chat-api-verification.md)
- [11 — Dashboard KPI definitions and API verification](plans/11-dashboard-kpi-contract.md)

Resolve's repository: https://github.com/adamstavely/resolve
Quackback fork: https://github.com/adamstavely/quackback
Never commit or push this work to QuackbackIO/quackback.
