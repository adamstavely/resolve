# Elastic Observability integration

Status: detailed proposed implementation plan, 2026-10-12. Owner confirms Elastic belongs in Resolve’s first release, both providers are reachable, and current versions are intended. No live deployment has been tested; exact builds, license and data coverage must be recorded during discovery. Companion: [ServiceNow integration](13-servicenow-integration.md).

## 1. Outcome and prototype assessment

Give support agents trustworthy system context alongside the originating application's Quackback conversation/ticket: service health, relevant known issues, customer-correlated errors, evidence for escalation, and independently observed action outcomes. Elastic supplies observations, not permission to operate a customer account.

Reviewed all seven artboards and their embedded example data in the user-supplied `Resolve integrations.html` prototype. Artboards 1–4 principally define this integration; artboards 5–7 consume its evidence alongside ServiceNow. The examples are mock data and contain proposed product behavior, not proof that existing APIs provide the derived conclusions.

Feature coverage:

- **Customer context (board 1):** incident banner; APM/RUM timeline; synthetic results by region; combined customer/system activity; restricted log patterns and trace links; link-to-case and copy-message actions.
- **Fleet health (board 2):** per-app health, SLO, alerts, synthetic status, known issues, impact estimates, matching-ticket counts, and live activity. Existing Quackback support KPIs remain separately labelled.
- **Action guardrails (board 3):** pre-flight health check; explainable warning/block; incident subscription; action receipt with independently verified stages.
- **Escalation evidence (board 4):** immutable health/error/log/action snapshot, cited summary, and review workflow. AI is an optional later stage.
- **Combined workflows (boards 5–7):** correlate telemetry with change windows/CI ownership, enrich ServiceNow linkage and approval. This plan does not introduce refund, freeze, or money-transfer executors.

Correct the prototype's unsupported certainty: a 502 and retry do not prove two settlements; MFA success does not prove a legitimate person; absence of an anomaly does not establish safety. Show facts, observed correlations, coverage limitations, and hypotheses separately. Payment and account examples require authoritative application events before those conclusions may be displayed.

### Confirmed release boundary

Owner confirmed the first-release scope: E0–E2 service health, known issues, authorized customer/system context where instrumentation exists, and escalation evidence snapshots, qualified by the applicable E5 tests. Action pre-flight checks and verified action receipts (E3) are deferred until after the first release and require the action executor and application instrumentation. E4 AI/ML enrichment remains optional later work, not a first-release gate. Qualification is required for the delivered scope even though later work packages remain deferred.

ServiceNow ships later. Elastic’s first-release functionality must operate without ServiceNow credentials, incident records, CMDB or approvals. Use Elastic issue/case references and Resolve service mappings; attach ServiceNow INC links when that integration arrives.

## 2. Architecture and ownership

Browser → Angular/Web Component UI → authenticated Next.js endpoints → Elastic adapter → approved Elasticsearch and Kibana endpoints. Background polling, reconciliation, subscriptions and receipt watchers run in a separate durable Node worker, not a timer in a route handler. Resolve PostgreSQL holds mappings, normalized snapshots, jobs and audit; it is not a replacement log store.

Quackback continues to own its conversations and tickets under the current plan. Elastic owns telemetry, alert lifecycle, SLO calculations and Elastic Cases. Resolve owns correlation rules, evidence snapshots and explicitly requested integration operations. A linked Elastic Case is not a Quackback ticket or ServiceNow incident; retain each provider's ID independently.

Use `packages/contracts` for versioned DTOs, proposed `apps/api/lib/integrations/elastic` for adapters, a dedicated integration-worker entry point, and existing Angular/Web Component conventions for UI. No dependency on Quackback source internals, Kibana private UI endpoints, or embedded Kibana screens. External deep links are optional conveniences and retain Kibana's own access controls.

## 3. Verified API families and remaining discovery

The [official Observability API catalogue](https://www.elastic.co/docs/solutions/observability/apis) confirms separate API families rather than one universal customer-context endpoint. Pin the deployed Elasticsearch/Kibana version and Stack versus Serverless mode before freezing request/response fixtures.

- Telemetry retrieval: Elasticsearch `POST /{index}/_search`, restricted to configured aliases/data streams. Use bounded time ranges, explicit field projections and parameterized term filters. [Search API](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-search.html).
- Stable drilldown: use `search_after` with a point-in-time snapshot where stable pagination is needed; expire/close snapshots and invalidate cursors when authorization or mapping changes. [Pagination guidance](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results).
- SLOs: documented version-specific Kibana route `GET /s/{spaceId}/api/observability/slos`; verify its summary fields, freshness and feature privileges against the installed release. Store the actual SLO ID and budgeting window; do not manufacture a burn rate from a headline percentage. [Versioned SLO API](https://www.elastic.co/docs/api/doc/kibana/v8/operation/operation-findslosop).
- Cases: documented find/get/comment APIs, including `GET /api/cases/_find` and `POST /api/cases/{caseId}/comments`. Include space and owner constraints, version checks for updates and compatible comment shapes. Case writes are a separately enabled capability. [Cases APIs](https://www.elastic.co/docs/api/doc/kibana/v8/group/endpoint-cases).
- Alerts: identify the supported alert-read contract for the deployed rule types. Listing rules is not listing current alert instances. If documented search over alert indices is required, pin index/field contracts and privileges and isolate them in the adapter. Do not scrape internal endpoints.
- Synthetics: distinguish monitor configuration from executed results. Read the configured result data stream for status, duration, location and last execution after fixture verification; do not interpret “monitor enabled” as “journey healthy.” Private-location deployment is an infrastructure prerequisite.
- Log patterns/ML: optional only when relevant jobs, results and entitlement exist. Capture job ID, bucket interval, baseline, score type and sample count. No ML data means unavailable, not zero anomalies.
- Correlation fields: use instrumented `trace.id`, `transaction.id`, service/environment and a namespaced application subject, following [ECS tracing fields](https://www.elastic.co/docs/reference/ecs/ecs-tracing). User/account correlation still needs an application-specific mapping.

Discovery must produce an executable fixture and negative-authorization test for each family. API documentation establishes feasibility; it does not prove this organization's telemetry coverage or license.

## 4. Connection and application onboarding

An integration administrator registers a connection: private Elasticsearch URL, private Kibana URL, space, CA trust configuration, secret reference, version and supported capabilities. Validate HTTPS, approved hosts, every resolved address and redirects; never disable certificate verification. Credentials stay encrypted server-side and are rotated independently of app mappings.

For each Resolve app/environment configure: approved index/data-stream aliases, service names/namespaces, regions, SLO IDs, monitor IDs, alert selectors, optional case tags/owner, approved deep-link base and subject-mapping policy. Multiple services per app and services shared by multiple apps must be explicit. A service name alone is not a tenant boundary. Configuration activation requires a preview against a known synthetic subject and a second-app isolation test.

Instrumentation prerequisite for customer context: events must carry a stable app-scoped subject and environment. Map a verified Quackback principal to that subject through an authoritative application adapter. Never match by email, IP, display name or browser-supplied user ID. Where this mapping is absent, provide service-level context only.

No runtime public internet is assumed. Confirm private routes to both Elastic endpoints and internal synthetic runners. SaaS access is a network decision, not an exception silently introduced by the connector.

## 5. Normalized contracts and data model

Proposed Resolve endpoints, not existing upstream APIs:

- `GET /api/apps/{appKey}/observability/health`: component results plus aggregate state.
- `GET /api/apps/{appKey}/conversations/{id}/observability`: authorized subject context, default 24h and bounded maximum configured by policy.
- `GET /api/apps/{appKey}/observability/issues`: permitted issues and explicit matching reasons.
- `POST /api/apps/{appKey}/evidence-snapshots`: immutable snapshot for an authorized ticket/request.
- `POST /api/apps/{appKey}/actions/{requestId}/preflight`: snapshot tied to exact action and target.
- `GET /api/apps/{appKey}/actions/{requestId}/receipt`: observed outcome stages, never an execution endpoint.

Every response includes schemaVersion, appKey, environment, connection/mapping revision, observedAt, fetchedAt, expiresAt, source IDs and completeness (`complete`, `partial`, `unavailable`). Distinguish `unknown`, `healthy`, `degraded`, `critical` and `stale`; absence of data never implies healthy. Return bounded sanitized evidence, not arbitrary search results. Cursors bind app, viewer permission revision, query hash and expiry.

Proposed tables: `integration_connections` (shared with ServiceNow); `elastic_app_mappings`; `integration_checkpoints`; `observability_health_snapshots`; `known_issue_links`; `evidence_snapshots`; `action_preflights`; `action_receipt_observations`; `issue_subscriptions`. Unique external references include connection, space, app/environment and provider ID. Common `integration_operations` stores leases, fencing token, payload digest, outcome and retry metadata.

Evidence snapshot stores requested window, source window, redacted facts, source document IDs, rule/query revision, capture time, completeness, viewer classification and content hash. A later refresh creates a new revision rather than rewriting what the reviewer saw. Hashes demonstrate consistency, not truth. Access is checked on every view and export, including links placed in ServiceNow.

## 6. Correlation, counts and refresh

Known-issue match requires configured service/environment plus overlapping time, and, where available, region, operation and exact error code. Return matched criteria and missing criteria; candidates require agent confirmation before linking. Time proximity alone does not establish causality.

Affected-customer count means distinct instrumented app subjects in a defined event predicate/time window. State whether approximate cardinality or exact count, coverage, last update and exclusions. Do not label all users of a degraded service as confirmed affected. Matching-ticket count is calculated from authorized Quackback records, deduplicated by app/ticket, separately from affected subjects.

Initial configurable targets: active app health poll 30 seconds; visible subject context refresh 60 seconds; stale after two missed health polls; bounded worker concurrency and per-connection backoff. These are proposed load-test inputs, not guaranteed freshness. No per-browser polling fan-out. Dormant apps remain opt-in unless active monitoring is configured.

Publish normalized invalidations over Resolve's authenticated stream after committing the snapshot/outbox. Subscribe before snapshot read, maintain revision order, recover via cursor or resync. Webhook alerts may accelerate refresh where private delivery is supported, but remain untrusted hints until source revalidation. Persist dedup keys/checkpoints; reconcile after dropped, duplicate and out-of-order notifications. API 429 honors Retry-After; revoked credentials show unavailable promptly.

## 7. Pre-flight policy and verified receipts

Pre-flight combines action definition, app/subject, owning ticket, approved service dependency mapping, current health and optional ServiceNow change restriction. Store policy version, evidence IDs and freshness. Outcome: allow, warn, block or unknown. Initial read-only milestone merely displays context; execution gating ships only with the separately approved account-action executor.

A “Run anyway” button may override an advisory warning only when policy permits and the agent supplies a reason. It never overrides missing permission, expired approval, invalid target, or a hard block. At dispatch revalidate target, authorization, approval binding and pre-flight expiry. High-impact actions default to refusing stale/unknown pre-flight; lower-risk behavior is a product decision. Do not automatically rerun when an incident clears; notify and require a new authorized attempt.

Propagate one operation ID through Resolve, the application executor and downstream telemetry. Define per-action receipt predicates with source, expected event, success/failure meaning and timeout. Stages include accepted, execution-confirmed, downstream-observed, failed and unverified. A Resolve audit-index event proves only logging; SMTP acceptance does not prove inbox delivery; link-open needs an explicit instrumented event. Late evidence can upgrade an unverified receipt without resending the action. No telemetry match is not proof of failure.

Application business APIs remain authoritative for balances, refunds and completion. Read-model telemetry is corroboration. This feature requires application instrumentation plus idempotent execution/status APIs, not only Elastic configuration.

## 8. Security, accessibility and retention

Separate capabilities for service-health read, subject evidence read, restricted log/trace read, snapshot export, case linking and pre-flight override. Prototype tier labels are presentation hints, not a new authorization model; no automatic Tier 4 introduction. Enforce app and ticket access server-side before any search. Use least-privilege read credentials and separate optional write credentials; never expose API keys to the browser. Source document/field restrictions provide defense in depth where supported.

Redact credentials, tokens, payment data and unapproved personal fields before cache, log, export or AI input. Limit queries, source fields, response sizes and runtime; do not accept raw Elasticsearch DSL/KQL from ordinary users. Audit sensitive reads/exports with source, actor and app. Proposed retention: health cache 24h; restricted evidence snapshots 30 days; audit according to existing organization policy. These require owner approval and deletion/hold procedures.

Use established Angular/shadcn Web Components. Health has text and icons, not color alone. Timelines also expose ordered text; charts have equivalent values. Dynamic refresh preserves focus and selected ticket; announce meaningful changes politely, not every poll. Verify keyboard drilldown, dialog restoration, 320px reflow, enlarged text, contrast and screen-reader navigation manually and with automated checks.

## 9. Delivery work packages and acceptance

**E0 — environment and contracts.** Integration engineer + Elastic owner validate version/license/network, aliases, mappings and golden data for two apps. Exit: real positive and negative calls; documented unsupported panels; operational owner and volume budget.

**E1 — read-only health.** Backend adapter, worker/checkpoints, scoped cache, app configuration and health/known-issue UI. Exit: degraded/empty/stale/permission-denied states correct, no cross-app data, outage does not break support chat. No action coupling.

**E2 — subject context and evidence.** App teams instrument stable identity and trace correlation; Resolve builds timeline, redacted drilldown and immutable snapshots. Exit: customer A/B and app A/B isolation, missing identity safe fallback, accurate sampling/approximation labels, reproducible snapshots.

**E3 — deferred: guarded action receipts and case linkage.** Depends on an approved executor, policy contract and instrumented outcome events. Add warning/block rules, override audit, per-stage receipts and incident-clear subscriptions. Exit: action acceptance never masquerades as downstream success; expired evidence requires recheck; ambiguous writes reconcile rather than duplicate.

**E4 — advanced patterns and optional summaries.** Add ML-backed pattern panels and internally hosted model summaries only after evidence quality is proven. Each claim cites snapshot facts; unsupported inference is labelled or omitted. Test malicious text in logs as untrusted data, insufficient evidence, and model unavailability. Human review remains mandatory.

**E5 — qualification.** Test maximum agreed app/operator/query volume, reconnect storms, slow indices, late telemetry, DST/UTC windows, source retention expiry, rollover, mapping changes, revoked keys and worker crashes. Upgrade a pinned Elastic version using contract fixtures before rollout. Accessibility review and private-network trace confirm no public dependencies.

Use feature flags per connection and app. Canary one nonproduction app then one production app; rollback disables polling/writes while preserving evidence/audit. Maintain a connector kill switch. Release evidence includes sanitized real payloads, negative tests, load results and runbook. No calendar estimate until E0 and the volume assumptions are resolved.

## 10. Owner decisions

1. Current versions and reachability are confirmed; discovery must record exact builds, Stack/Serverless mode, license, spaces and scoped credentials. Who owns that setup?
2. Which services already emit stable app-subject IDs, trace IDs and authoritative action outcomes, and who owns missing instrumentation?
3. Which agents may view raw redacted traces/logs versus service-level summaries, and what snapshot retention is permitted?
4. Which action categories should block on degraded or unknown service health, and who may override advisory warnings?
5. Resolved by owner: context and evidence first (E0–E2 plus applicable qualification); action pre-flight checks and verified receipts later.
6. Is an Elastic Case a maintained engineering record, or should issue linkage prefer ServiceNow incidents when both exist?
7. Are the proposed 30-second health refresh and 60-second subject refresh adequate, and at what app/operator volume?

Resolved by owner, 2026-10-12 (implementation in [plan 14](14-elastic-implementation.md)):
- Deployment: Elastic Cloud Hosted 9.x over a private link; build against a mock and pin the exact build in E0.
- Subject mapping: the fork's verified `external_id` (signed-token identify `sub`), exposed via a new tenant tool gap (QB-OBS-1); no verified id means service-level context only.
- Evidence: an immutable Resolve snapshot tied to the Quackback ticket/conversation, with an internal note linking it; Elastic Cases are read-only (answers decision 6 for the first release).
- Access: capabilities instead of prototype tiers — health for agents and observers, subject context for agents, redacted traces/logs and export for a new investigator bundle (answers decision 3's first half; retention remains open).

No answer is assumed merely because it appears in the prototype. Independent E0/E1 specification work can proceed while execution-related choices remain open.
