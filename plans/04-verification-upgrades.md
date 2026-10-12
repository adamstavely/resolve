# Verification, release evidence and upstream upgrades

## Validation layers

- Unit: capability calculations, audience-free broadcast inputs, identity mapping, version comparisons,
  retry classifications, redaction and stable pagination merge.
- Contract: real tenant tool schemas/scopes, OAuth claims, registry projection and worker command API.
  Run against the pinned current fork and candidate upstream upgrade, including permissions and row access.
- Database: migration/receipt ordering, atomic grant reconciliation, denied-user fallback, queue fencing,
  broadcast idempotency and crash-after-commit recovery using real PostgreSQL.
- Browser: SSO connect/reconnect, partial fleet outages, operator confirmation, uncertain broadcast
  resolution, keyboard navigation, focus, zoom/reflow and manual screen-reader checks.
- Infrastructure: no runtime internet egress; private CA; RDS proxy behavior and capacity; S3 access;
  KMS/IAM least privilege; maintenance ingress; real mail headers and raw MIME; directory outage.

## Blocking acceptance scenarios

1. Tenant fails an access probe: normal users never reach it, even if provisioner crashes.
2. Same issuer/subject is used for tower and app: mapping succeeds; another user cannot claim it.
3. Same email/different subject cannot acquire a managed tenant identity or session.
4. Older enable job follows newer disable: tenant stays denied; dead worker jobs are reclaimed safely.
5. Directory stops while tenant sync succeeds: lease cannot extend from cached data.
6. Fork-only release reaches upstream-current tenants; suspended tenant resumes across multiple releases;
   catalogue receipts and template reconciliation cannot report success before commit.
7. Human mutation times out after tenant commit: no duplicate retry, durable uncertain outcome and
   correlation to actual tenant author. Broadcast replay is idempotent per app and request revision.
8. Mail arrives while app is suspended: retained and delivered once visibly after resume.
9. Global pagination preserves fetched-but-not-displayed items; failed app does not silently lose its page.
10. Portal and application-embed broadcasts use the Everyone audience and reach the reviewed applications.

## Upstream upgrade procedure

Resolve must not import upstream internals. Record semantic dependencies in Quackback, not just edited files:
auth resolution/linking, role fallback/seed behavior, tenant scope/registry caching, migrations and receipts,
MCP actors/tools/resources, storage and inbound delivery. Each dependency gets a named owner and executable
contract test. Update snapshots only after inspecting behavior changes.

Rehearse a populated fleet: active and suspended apps, managed/unmanaged users, denied users, open operations,
OAuth grants, announcement history and queued mail. Apply upstream plus fork changes, run migrations,
roll worker/Resolve/tenant versions in the documented order and resume an old tenant. Exercise rollback
within the supported schema/protocol window. Passing an empty install or a clean Git merge is insufficient.

## Evidence and sign-off

Each release stores exact commits/images, test commands/results, known limitations and responsible sign-off.
Security owns identity/privileged boundaries, operations owns backup/restore/network/mail, product owns scope
and access policies. These are roles to assign, not claims that reviewers already exist or have approved.
CI passing is necessary but does not replace live IdP, AWS, accessibility or disaster-recovery validation.
