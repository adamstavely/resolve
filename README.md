# Resolve

Resolve is the internal control tower for the organization's Quackback fleet.
Status: **phase 0 (integration discovery)**. The repository contains a development foundation used to
validate the stack (Angular console hosting shadcn React controls as Web Components, Next.js API on
Node.js, PostgreSQL migration runner). No authentication, tenant access, infrastructure or deployment
exists yet; see the phase exit criteria in the delivery plan.

Start with [the delivery plan](plans/00-delivery-plan.md). The active specification is the numbered
planning documents here; the imported [Quackback v2 plan](plans/reference/20-control-tower-quackback-v2.md)
is a historical reference, not an implementation-ready specification.

## Development

Requires Node.js from `.nvmrc` (24.15 or later, below 25) and a disposable PostgreSQL for database work.

```sh
npm ci
npm run dev                # API on 127.0.0.1:3100, console on 127.0.0.1:4200 (proxies /api)
npm run check              # typecheck, console build and unit tests
npm run test:e2e           # Playwright + axe; PW_CHANNEL=chrome uses installed Chrome
QUACKBACK_SRC=../quackback npm run test:contract   # tool inventory vs. the pinned fork
docker run -d --name resolve-db -e POSTGRES_USER=resolve -e POSTGRES_PASSWORD=resolve \
  -e POSTGRES_DB=resolve -p 127.0.0.1:55432:5432 postgres:18
DATABASE_URL=postgres://resolve:resolve@127.0.0.1:55432/resolve npm run db:migrate
DATABASE_URL=postgres://resolve:resolve@127.0.0.1:55432/resolve npm run db:test
```

Phase 0 evidence: [component gate](docs/evidence/phase-0-component-gate.md),
[contracts and tool inventory](docs/evidence/phase-0-contracts.md).

`/api/readiness` reports ready only when the API process has `DATABASE_URL` and migrations are applied.

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
