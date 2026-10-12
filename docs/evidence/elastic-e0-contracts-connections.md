# Elastic E0 evidence: contracts, mock Elastic and connections

Status: 2026-10-12. E0 from [plan 14](../../plans/14-elastic-implementation.md), built and tested against a development mock of Elastic Cloud Hosted 9.x.
**No real Elastic deployment has been called yet.** The real half of E0 still needs:
- the private link
- read-only API keys
- a live fixture recording (see "Not yet done")

Owner decisions applied (plan 14 §1):
- **Deployment:** Cloud Hosted 9.x.
- **Customer matching:** the fork's verified `external_id` (QB-OBS-1).
- **Evidence:** attached to the ticket, with an internal note. Resolve never writes to Elastic.
- **Access:** capabilities instead of tiers.

## What exists

**Contracts** (`packages/contracts/src/observability.ts`)
- Every observability read carries its provenance:
  - schema version, app, environment
  - connection and mapping revision
  - observed, fetched and expiry times
  - `complete`/`partial`/`unavailable`, and which families are missing
- Health states include `unknown` and `stale`; no data is never `healthy`.
- Normalized results for SLOs, alerts, synthetics, cases and subject events.
- The connection, credential and kill-switch requests.
- The app-mapping shape that E1 configures:
  - index patterns may not be bare `*`, hidden (`.x`), cross-cluster (`a:b`) or excluded (`-x`)
  - services shared by several apps need a discriminator

**Capabilities** (`capabilities.ts`)
- `observability.health`: agents, observers, admins.
- `observability.subject` and `observability.link`: agents, admins.
- `observability.restricted`: the new `observability-investigator` bundle, and admins. Locally that bundle maps from the `resolve-investigators` group in `.env.example`.
- `observability.configure`: admins only.
- The readiness check shows `subject` blocked by QB-OBS-1, and `link` by the note tools' existing gaps.

**Fork gap QB-OBS-1** (`tenant-tools.ts`)
- `get_customer_identity` returns the customer's verified external id for a conversation or ticket the caller can read. A customer identified any other way is unverified and gets no id.
- The fork already stores this id (`user.external_id`, set only on the signed-token identify path), but no tool exposes it.
- The mock tenants implement it: customers 1–6 are verified as `cust-1`…`cust-6`; customers 7 and 8 are unverified.

**Migration 0008** adds:
- **Connections:** `integration_connections` (exactly one credential source, enforced) and `elastic_app_mappings` (can't be `active` until preview and isolation have passed).
- **Background work:** `integration_operations` (leases, fencing, idempotency key) and `integration_checkpoints`.
- **Health and issues:** `observability_health_snapshots`, `known_issues` (unique per provider id, space and app), and `known_issue_links` (one per issue and object, with an INC column reserved for plan 13).
- **Evidence:** `evidence_snapshots`. A trigger makes them immutable apart from the note outcome and the hold flag.
- E3 tables are left out on purpose.

**Elastic client** (`apps/api/lib/integrations/elastic/client.ts`)
- **Connecting:**
  - Hosts must be on `ELASTIC_ALLOWED_HOSTS`, over HTTPS; plain HTTP only for a loopback mock outside production.
  - No credentials in URLs.
  - The resolved address is checked, then pinned for the connection; link-local/metadata, multicast and unspecified addresses are refused.
- **Responses:**
  - Certificates are always verified, with an optional private CA.
  - Redirects are refused.
  - Time and size are bounded.
  - 429 returns Retry-After.
  - Errors are codes; response bodies never reach logs or users.

**Family adapters** (`families.ts`)
- **Query safety:** each family builds a bounded query. Values go in as term values only, never user DSL or KQL. Fields are read through an explicit `fields` list.
- **SLOs:** status, target, window, and the 1h burn rate only when the SLO API reports it. Unknown SLO ids are listed as missing.
- **Alerts:** this space and these rules only; reasons are redacted.
- **Synthetics:** executed results per monitor and location. A configured monitor that hasn't run in the window is absent, not "up".
- **Cases:** titles only. Descriptions and comments are never read.
- **APM and RUM for one subject:** scoped by service, environment and discriminator.
- **Discovery:** probes and versions.

**Redaction** (`redact.ts`) scrubs:
- bearer/API keys, JWTs and `key=value` secrets
- AWS and Stripe-style keys
- Luhn-valid card numbers (other long numbers are left alone)
- emails, international phone numbers and IBAN-like account numbers

It also strips control characters and bounds length.

**Mock Elastic** (`tools/mock-elastic`, `npm run dev:elastic`, ports 3400 and 3401)
- **Endpoints:**
  - Elasticsearch: `GET /`, `_search` and point in time.
  - Kibana: status, SLO get/find and Cases find, in 9.x shapes.
- **Query evaluator:** handles the DSL subset the adapter uses, and rejects anything else.
- **API keys:** carry index and Kibana space/feature privileges, with Elasticsearch's semantics. A wildcard expands only to authorized indices; naming an unauthorized index is a 403.
- **Scenario:**
  - Payroll is degraded: an active alert, a burning SLO, a payslip journey failing in eu-west only, and an open case.
  - HR is healthy.
  - Legal has no data.
  - notification-service is shared by payroll and HR and told apart only by `labels.app`; both apps have a `cust-1`.
- **Dev controls** (`/dev/*`): faults (slow, 429, 503), revoking keys, late documents and reset.

**Fixture recorder** (`npm run elastic:fixtures`)
- Runs the adapter's own requests and records each request and its raw response.
- **What's stored:**
  - Strings are redacted and subject ids hashed.
  - Fields the adapter never reads (descriptions, comments, messages) aren't recorded.
  - Negative-key responses are included.
- **Modes:** `--mock` writes `tests/fixtures/elastic/mock`. A live run writes `tests/fixtures/elastic/live`, and the same contract tests then cover it.

**Connection administration** (API under `/api/admin/integrations/connections`, console **Administration → Integrations**)
- **Adding:** name, endpoints, space, a read-only key (masked as it's typed; sealed, bound to its row, never returned) or an `env:` secret reference, and an optional private CA.
- **Test:** records the versions, and for each family whether it's available, not found, or not permitted.
- **Replacing the key:** version-checked; clears the test results.
- **Kill switch:** needs a reason and confirmation, and stops every read at once.
- **Audit:** every change, in the new `observability` audit category.

## Exit criteria (plan 14, E0)

| Criterion | Evidence |
|---|---|
| Positive and negative-authorization test for each query family | `elastic.unit.test` › API families (SLO, alerts, synthetics, cases, APM, RUM) and › discovery and negative authorization (reader, narrow and revoked keys) |
| Contract checks in CI | `elastic.unit.test` › recorded fixtures: the adapter parses every recorded response with nothing dropped; negative responses are refused or empty; no secrets or subject ids were recorded |
| A service name alone is not a tenant boundary | Payroll's mapping sees only payroll's notification-service events for `cust-1`, and HR's sees only HR's; staging and other spaces are excluded |
| No data is not health | A configured monitor with no recent run is absent; an SLO with no data reports `no_data`, with no value; Legal has no data at all |
| Credentials are write-only and sealed | `integrations.db.test`: ciphertext only, bound to its row (copying it to another connection fails to open); `integrations.spec`: no API response contains the key |
| Only integration administrators configure | `integrations.spec` › agents and observers get no nav entry and a 403 |
| Kill switch | `integrations.db.test` and `integrations.spec`: on means every read and test is refused (409); off restores; both are audited with the reason |
| Schema rules | `integrations.db.test`: a mapping can't activate without preview and isolation checks; snapshots are immutable; one link per issue and object |
| WCAG 2.2 AA | axe on the Integrations page; row headers, a visible table caption, a masked key field, and focus moved to the field at fault |

Full run on 2026-10-12:

| Suite | Result |
|---|---|
| Typecheck and builds | Clean |
| Unit | 236 passed |
| Database | 64 passed |
| Contract (against the pinned fork) | 31 passed |
| Browser (Chrome, one worker) | 73 passed |

## Not yet done (the real half of E0)

- **Live environment:** a private link to Cloud Hosted, plus a read-only and a deliberately narrow API key. The owner is not yet named.
- **Live fixtures:** a run of `npm run elastic:fixtures` with a mapping for two real apps, committing `tests/fixtures/elastic/live`.
- **Documented gaps:** a written list of the panels that deployment can't feed.
- **Version:** the exact build. The mock reports 9.1.0 as a placeholder.
- **Alert reads:** confirm against the deployed rule types that reading alerts-as-data through `.alerts-observability.*` is the supported contract (plan 12 §3).
- **QB-OBS-1:** needs a fork issue with an owner and an acceptance test.
- **Instrumentation:** each app must send the verified id as `user.id`.
