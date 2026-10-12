# Resolve

Resolve is the internal control tower for the organization's Quackback fleet.
Status: **phases 0–3 working against mocks: identity and connections, fleet read, and operator actions with the live inbox.** The repository contains
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
through the IdP session without a second prompt. Home then shows KPIs and activity; **Inbox** is the live chat queue and **Tickets** lists each app's tickets
(Legal Ops is idle until you load it). To simulate a customer writing in:
`curl -X POST -d '{"text":"Hello"}' http://127.0.0.1:3301/dev/customer-message`. To simulate a directory change:
`curl -X POST -H "Authorization: Bearer $DIRECTORY_TOKEN" -d '{"active":false}' http://127.0.0.1:3200/dev/users/mock%7Cbea/active`.
As Ada (admin), **Administration → Applications → Register application** onboards a new instance (or adopts the unbound
Travel Desk) through the mock fleet worker; **People and roles** manages bundles. As Bea, **Announcements** publishes banner content to all or selected apps
(each app draws it in its own banner style; see `http://127.0.0.1:3301/portal`). `npm run dev` also starts the fleet job
dispatcher (`npm run dev:jobs`) and a mock Elastic Cloud Hosted 9.x (`npm run dev:elastic`: Elasticsearch on 3400, Kibana on 3401).
As Ada, **Administration → Integrations** adds an Elastic connection (keys in `tools/mock-elastic/keys.json`), tests what it can read, and maps
applications to Elastic data (preview, isolation check, activate); the integration worker (`npm run dev:integrations`) then polls health, which
Home shows on the application cards and under **Known issues**. Tickets and conversations show **System context** (sign in as Ivy Investigator for trace ids and logs).
`npm run elastic:fixtures -- --mock` re-records the adapter's contract fixtures. Stream load test: `npm run load:stream -- --sessions 100` (see phase 3 evidence).

```sh
npm run check              # typecheck, console build and unit tests
npm run db:test            # database tests (DATABASE_URL from .env or the environment)
npm run test:e2e           # Playwright + axe against npm run dev; PW_CHANNEL=chrome uses installed Chrome
QUACKBACK_SRC=../quackback npm run test:contract   # tool inventory vs. the pinned fork
```

Evidence: [component gate](docs/evidence/phase-0-component-gate.md),
[contracts and tool inventory](docs/evidence/phase-0-contracts.md), [identity and connections](docs/evidence/phase-1-identity.md), [fleet read](docs/evidence/phase-2-fleet-read.md), [operator actions](docs/evidence/phase-3-operator-actions.md),
[fleet administration](docs/evidence/phase-4-fleet-administration.md), [banner broadcasts](docs/evidence/phase-5-banner-broadcasts.md),
[Elastic E0](docs/evidence/elastic-e0-contracts-connections.md), [Elastic E1](docs/evidence/elastic-e1-health-known-issues.md), [Elastic E2](docs/evidence/elastic-e2-customer-context-evidence.md), [Elastic E3](docs/evidence/elastic-e3-preflight-receipts.md), [Elastic E4](docs/evidence/elastic-e4-patterns-summaries.md).

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
- [12 — Elastic Observability integration: first release](plans/12-elastic-observability-integration.md)
- [13 — ServiceNow incident integration: after first release](plans/13-servicenow-integration.md)
- [14 — Elastic integration: implementation plan](plans/14-elastic-implementation.md)

Resolve's repository: https://github.com/adamstavely/resolve
Quackback fork: https://github.com/adamstavely/quackback
Never commit or push this work to QuackbackIO/quackback.
