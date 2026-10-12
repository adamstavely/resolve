# Architecture and integration contracts

## Agreed application stack

Angular owns the Resolve UI and routing. Official shadcn/ui React controls are wrapped in registered
Web Components, with shared React runtime and typed Angular adapters. Next.js Route Handlers run on
Node.js as the backend. Quackback APIs supply tenant operations; Quackback screens are not embedded.
Full WCAG 2.2 AA conformance is a release gate, including the component bridge and authentication flow.
See document 06 for the design references, adapter spike and accessibility evidence requirements.

## Runtime boundaries

Browser → internal edge SSO → Resolve. Resolve → tenant HTTPS OAuth/MCP endpoints over approved private
DNS routes. Resolve → its own PostgreSQL database and managed AWS dependencies via private endpoints.
A distinct Quackback worker role connects to tenant databases and holds privileged secrets.
The tower must not gain arbitrary shell execution by being able to dispatch that worker.

Proposed own database on the shared managed PostgreSQL cluster, separate login and migrations. Keep
registry ownership with the Quackback fleet adapter. Resolve reads a versioned, column-limited view or
API; never creates an independently maintained duplicate of the upstream registry schema.
Single fleet bucket remains an infrastructure decision; Resolve tokens belong in its database using
KMS envelope encryption and separate IAM grants, not in readable registry fields.

## Contract catalogue (proposed v1)

1. Registry read: stable app key, display name, primary hostname, routability/state, deployment/protocol
   version and last activity. No DSN, secret reference or root-key material. Unknown state is unavailable.
2. Human OAuth: confidential client per tenant, exact callback URI, PKCE S256, single-use state bound to
   Resolve session/user/app, expiring connect attempt. Verify issuer, audience, signature and mapped
   tenant user/principal before storing credentials. Persist token rotation atomically under a grant lock.
   Lost refresh response becomes reconnect-required unless provider recovery behavior is proven.
3. Tenant tools: exact name, argument schema, result schema, scope, permission, object policy,
   idempotency behavior and minimum Quackback version. Capture from actual handlers, not plan examples.
4. Privileged jobs: allowlisted command plus app key, request ID, desired-state version, initiator
   identity and validated parameters. Resolve sends no DSN or secrets. Worker returns job ID, state,
   stage, version and redacted failure code. No arbitrary command, image, role or environment overrides.
5. Audit: operation ID links Resolve intent to tenant/worker result. Store human subject and principal,
   system executor, app, operation, redacted parameter summary and outcome. Background directory work
   records source event/version instead of inventing a human actor.
6. Compatibility: worker and tenant expose supported protocol versions/capabilities. Unknown or
   incompatible mutation contracts are disabled with an actionable UI explanation; no guessed fallback.

## Data model owned by Resolve

- users: internal ID, enabled state and authoritative directory version; email is mutable display data.
- identities: unique issuer/subject identity owned by one Resolve user; identity usages link the same
  identity to tower login and app-facing providers. This permits one IdP identity to serve both uses.
- tenant_identity_links: user/app → provider identity, tenant user ID and tenant principal ID. Allow
  per-client/pairwise subjects; do not assume one app subject across every OAuth client.
- roles, role_members and role_app_teams: capability bundles, claim/manual sources and explicit team mappings.
- tenant_clients and user_tenant_grants: encrypted secrets/tokens, scopes, expiry, connection state and
  mapping version. An identity mapping change invalidates the related grants.
- connect_runs/attempts: app queue, state hash, verifier secret, expiry, consumed time and outcome.
- directory_observations: source, version/cursor, observation time, covered user and active status.
- desired_entitlements and jobs: per-user/app monotonic desired version, payload digest, lease/fencing
  token, attempts, retry time and applied version. See document 02 for ordering.
- audit_operations and audit_events: durable intent, append-only transitions, tenant correlation.
- broadcasts and deliveries: immutable request revision, selected apps, per-app idempotency key,
  payload hash and pending/succeeded/failed/uncertain state.

Tenant denial, role provenance and schema receipts remain tenant-owned in Quackback. Do not create
Resolve foreign keys to tenant databases. Define retention/redaction before production schema approval.

## Aggregation and user experience

Bound concurrency (initial proposal 6) and per-app timeout (4 s); treat these as load-test inputs.
Show app provenance on every result. Return partial results and connection failures explicitly.
First release can paginate per app. A global sorted page requires a k-way merge retaining unconsumed
rows/cursors, stable tie-breakers and a snapshot/filter identity; simply forwarding each app's next
cursor loses fetched-but-not-displayed rows. Never claim stable global pagination without those tests.
Cache reads per user/app/permission version; invalidate on role change or denial. Do not cache across users.
Passive dashboards give dormant apps an explicit load control. Active SRE chat monitoring (document 09) maintains authorized live subscriptions and may keep monitored tenants warm; the UI must show which apps are actually monitored. Mutations always use the selected tenant's human token.

## Everyone announcements

Portal and application-embed announcements use the Everyone audience.
App selection still matters: broadcasting to Payroll and HR is not broadcasting to the entire fleet.
Tenant upsert/list/archive tools and broadcast idempotency must be implemented in Quackback before Resolve
calls them. Reconcile uncertain outcomes using the same request key and payload hash; reject reuse with
changed content. Status-content permissions are not removed by simplifying announcement targeting.
