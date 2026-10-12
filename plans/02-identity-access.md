# Identity, permissions and revocation

## Identity proof

Use immutable issuer/subject pairs, not email, as identity keys. Resolve and each app may see different
subjects; provision through a verified directory/broker mapping and persist each app's mapping.
A single identity record may have both tower and app usages without violating uniqueness.
Tenant pre-linking must be atomic and reject ambiguous or duplicate accounts.

Quackback must enforce managed-account linking rules during authentication, before issuing a session.
Periodic cleanup of unexpected email-linked accounts is not an authorization control. Test reused email,
changed email, an existing OTP account, different subject with the same email and simultaneous first login.
The exact Better Auth seam is a phase-0 code verification item, not assumed to be a configuration switch.

## Authority

Resolve checks capabilities server-side; Quackback independently checks scopes, permissions and objects.
Read-only bundles request no write scope. Proposed seed bundles remain Fleet Owner, Fleet Agent,
Fleet Observer, UX, Dev, Stakeholder and Tier 1–3; verify exact permissions against current fork catalogue.
Tower-managed principals have their entire role set managed by the authoritative Quackback writer.
Unmanaged users are untouched. A missing app/team mapping grants nothing for that team bundle.
Active people with no staff bundle become portal users, not legacy members with an empty role set.
No-role fallback must never grant Manager. Disabled is a separate denial state, not just an empty grant set.

First-release capability/tool grants cover chat/ticket work, onboarding, fleet dashboard and announcements
only. Do not request feedback triage/merge, roadmap or changelog capabilities just because historical
seed bundles included them. Broad OAuth scopes needed by an in-scope endpoint remain bounded by explicit
per-tool permissions. UX/Dev/portfolio-specific surfaces and grants are not first-release deliverables.

## Durable desired-state synchronization

Directory/manual changes atomically increment per-user/app desired_version and enqueue work. Workers
claim a leased job with a monotonically increasing fencing token; abandoned jobs can be reclaimed.
Per-user/app operations serialize. Before applying, read latest desired state and discard obsolete jobs.
Tenant apply stores last_applied_version atomically with its changes; older versions cannot replace it.
Denial/undenial uses that same version contract. An old re-enable must never lift a newer disable.
A retry with the same version and different payload hash is an error. Cross-database completion is
at-least-once, with idempotent tenant effects and reconciliation of missing acknowledgements.

Test disable → enable → disable with delivery reordered, worker crash after tenant commit, concurrent
workers, and a delayed local/admin role write. Define reactivation reason explicitly; lifting lease expiry
must not lift a directory/manual denial. Keep manual emergency denial independent of directory state.

## Request-time enforcement

Prerequisite in Quackback: denial checks on existing cookie sessions, direct widget bearer sessions,
MCP JWTs, API keys including creator, new session creation and signed stream tokens. Existing streams
recheck within the specified heartbeat (proposed 20 seconds). Cleanup deletion and demotion do not enforce
security; last-admin demotion failure cannot make a denied session usable.
Resolve also denies disabled users on its own requests and closes authenticated streams. Revoke access
to saved grants even when tenant delivery is temporarily unavailable. In-flight external side effects
cannot be recalled; record when authorization was last checked and the action was dispatched.

## Directory and lease semantics

15 minutes remains a revocation target, not a guaranteed maximum. Measure directory detection, queue delay,
worker execution and retries separately. Alarm stale directory observations and outstanding revocations.
Supported directory polling/SCIM adapter is an implementation prerequisite; OAuth/SAML compliance alone
does not imply a usable directory API.

Optional lease remains off pending owner choice. If enabled, expiration is capped at the authoritative
source observation time plus lease duration, enforced on every request with cleanup workers stopped.
Successful tenant writes do not renew it. A delta poll counts as fresh coverage only when the provider
contract proves all relevant changes through that checkpoint were obtained; an advanced opaque cursor
alone is insufficient evidence. Stale/replayed SCIM events cannot re-enable newer disabled state.
Use provider versions when available; otherwise re-read current authoritative state before reactivation.
Document source consistency and clock-skew assumptions rather than promising an unconditional hard bound.

## Required security evidence

Race session insertion against denial; test last-admin failure; stop directory and cleanup while sync
continues; reorder revoke/reactivate jobs; replay OAuth state; switch tenant/account mid-connect; attempt
writes with Observer; send direct IDs outside the caller's access. All must run before operator actions ship.
