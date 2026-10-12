# ServiceNow integration

Status: detailed proposed implementation plan, 2026-10-12. Confirmed by owner: ServiceNow owns INC incidents; Quackback owns basic support tickets; link them when needed. ServiceNow integration ships after Resolve’s first release. Owner reports current versions and approved reachability; exact release/build, modules and instance customizations still require a recorded capability probe, not another architecture decision. Companion: [Elastic integration](12-elastic-observability-integration.md).

## 1. Outcome and prototype assessment

Bring service-management context into Resolve so agents can understand the associated case/incident, deadlines, ownership, recent changes and approved guidance without switching tools. Then add deliberate linking, reassignment, communication and approval workflows with durable recovery and accurate attribution.

Reviewed boards 5–7 of the user-supplied `Resolve integrations.html` prototype plus the Elastic dependencies in boards 1–4. These depict:

- Case strip with priority/state/group/assignee, response and resolution SLA, parent major incident and next update.
- CMDB-backed service ownership, change timeline, on-call/backup and paging.
- CSM entitlement/contact preference/history/satisfaction; suggested knowledge, stale-article feedback and draft creation.
- Audited automatic work notes for relevant Resolve operations.
- Candidate matching and bulk case-to-incident linkage with approved customer communication.
- Parent resolution cascading to case closure, and customer reply reopening a case.
- Escalation as reassignment plus approval with preserved SLA, evidence snapshot and proposed alternative action.

These are separate integrations and business processes, not one Table API connection. The prototype's financial actions and Cerbos label are unapproved architecture additions; no new policy engine or business executor is assumed.

## 2. Confirmed record ownership and scope

Quackback is authoritative for basic support tickets, conversations, assignment, support-ticket lifecycle and its SLA. ServiceNow is authoritative for INC incidents, incident assignment, incident lifecycle and its SLA. Resolve links a Quackback support ticket to an existing ServiceNow incident when needed. One incident may have many linked support tickets. Proposed default: one primary active incident link per support ticket, with historical links retained; secondary related links can be added later.

A link does not copy ownership or make the support ticket a ServiceNow CSM case. Closing an incident does not automatically close Quackback tickets. Reassigning an incident does not reassign linked support tickets. Show both sources and their state independently. The initial ServiceNow integration supports selecting an existing INC, creating a new INC, and appending internal work notes from Resolve. Each mutation requires its own permission, durable operation ID and source-side deduplication.

The prototype's CSM case strip, CSM entitlements/history, APV workflow and case-to-case mirroring are optional future extensions, not baseline requirements. Adapt boards 5–7 to a Quackback support-ticket header plus a linked ServiceNow incident panel. Retain incident ownership, changes and approved communication context where the installed modules support them. Do not copy the sample CS record model into production.

The initial ServiceNow integration after Resolve’s first release includes incident lookup/context, controlled QB-ticket-to-INC linking, incident creation and internal work-note write-back. Later slices may add communication assistance, CMDB/change/on-call and knowledge context. Destructive account actions and ServiceNow approvals require separate scope approval and are not prerequisites for incident linkage.

## 3. Feasibility and verified API families

ServiceNow documents REST endpoint ACLs and authentication; instance-specific roles, fields and plugins still require discovery. Use a least-privilege integration identity, never an administrative account just because an explorer example uses one. [REST API reference and access controls](https://www.servicenow.com/docs/r/api-reference/rest-api-explorer/c_RESTAPI.html).

- ITSM incident/change/CMDB reads: candidate Table API routes `/api/now/v1/table/incident`, `/change_request`, `/cmdb_ci` and approved related tables. Discover actual fields, relationship tables, ACLs and domain separation. Request explicit projections and bounded filters. [Table API](https://www.servicenow.com/docs/r/xanadu/api-reference/rest-apis/c_TableAPI.html).
- CSM: documented `/api/sn_customerservice/case/{id}` and `/case/{id}/activities` require the CSM plugin and appropriate roles. Do not substitute an incident for a CSM case without changing the UI/contract. Validate update fields locally and verify persisted result because the documentation warns that update validation is limited. [Case API](https://www.servicenow.com/docs/r/xanadu/api-reference/rest-apis/case-api.html).
- Knowledge: use the installed Knowledge Management API and enforce authenticated access, article criteria, language and publication state. Confirm version/plugin availability. [Knowledge API](https://www.servicenow.com/docs/r/api-reference/rest-apis/knowledge-api.html).
- On-call: official `OnCallRotation` documentation describes a server-side script include, not proof of a universal external REST endpoint. Expose an approved scoped adapter if the instance lacks a supported endpoint. [OnCallRotation](https://www.servicenow.com/docs/r/api-reference/server-api-reference/c_OnCallRotationAPI.html).
- SLA: candidate read source is task SLA records plus approved schedule/business-time projection. Verify actual definitions and pause/restart rules; do not subtract current time from a deadline and call it remaining business time.
- Approvals, paging, parent linkage and lifecycle transitions: discover installed processes and supported server-side actions. Directly changing a generic approval row is not a complete business approval contract.

For operations requiring deduplication, expected version, atomic relationship updates or controlled attribution, propose a small ServiceNow scoped application with versioned Scripted REST APIs and its own ACLs. This is custom ServiceNow work owned by its platform team. [Scripted REST API guidance](https://servicenow.github.io/sdk/4.12.0/guides/scripted-rest-api-guide). API feasibility is documented; the selected instance's operational behavior remains a release gate.

## 4. Runtime, authentication and app mapping

Use Resolve's Node backend for connector requests and a durable integration worker for inbox/outbox processing, polling and reconciliation. Browser has no ServiceNow credentials and cannot submit arbitrary table names, encoded queries or URLs.

Private HTTPS connectivity must be confirmed. A hosted instance on the public internet conflicts with the existing no-public-egress requirement unless an approved private path exists or the owner changes that requirement. No silent network exception. Respect company CA, approved origins, DNS validation and credential rotation. Do not assume a MID Server alone creates a bidirectional private REST route; design and verify the exact topology.

Prefer delegated user OAuth where the instance supports the required workflows. For scheduled collection, use a constrained service principal. If a service identity performs writes, preserve the real technical actor and add authenticated Resolve requester identity/correlation in approved fields and audit; do not forge `sys_updated_by` or label the write “as Maya” without actual delegated attribution. Group membership never automatically grants Resolve privileges.

Application mapping includes instance, domain, app/environment, business service, service offering and CI sys_ids; allowed task type; group mappings; approved knowledge bases; state/priority transforms; fixed separate field-ownership policy and revision. Use sys_id for identity and display number only for presentation. Match CI to Elastic service via explicit app/environment mapping, not free-text name similarity.

Resolve user ↔ ServiceNow sys_user mapping is verified from authoritative identity attributes; no email-only auto-link. Customer/contact mapping is separate from agent identity. Existing SSO-employee context does not imply external-customer CSM entitlement; the prototype's consumer examples must be adapted to the actual ServiceNow data model.

## 5. Read experiences and semantics

**Linked INC context (baseline):** show type, number, state, priority, assignee/group, source time, source link and sync freshness. Distinguish no linked record, inaccessible record, deleted record and unreachable source without leaking unauthorized existence.

**SLA:** display source name, start/pause/breach/completion state, business elapsed/remaining values, source timestamp and timezone. Keep response and resolution separate. A stale countdown is labelled stale. Preserve ServiceNow business rules; never reset a clock by overwriting SLA fields during reassignment. Quackback and ServiceNow SLA cards remain distinctly labelled in linked-record mode.

**Changes:** query authorized CIs and relevant actual/planned windows; distinguish scheduled, approved, implemented, cancelled and rollback. State temporal correlation (“deployed seven minutes before errors”), not proven root cause. A pending change alone does not block business actions unless an approved policy maps it to those actions.

**Ownership/on-call:** show approved service-to-group mapping, current shift and source freshness. No fresh rota means unknown, not “nobody on call.” “Page” is a confirmed, rate-limited, separately authorized mutation with audited outcome; listing the current person is not notification delivery.

**Customer and knowledge:** permit entitlement, contact preference, case history and satisfaction only if supported and authorized. Search articles using curated incident/error/service terms, not a raw conversation dump. Respect record-level article access. Age flags are review hints; “14 months old” does not prove wrong. Draft creation is unpublished, attributed and reviewed by knowledge owners.

## 6. Shared records and Resolve APIs

Shared `integration_connections`, `integration_operations`, checkpoints and durable audit infrastructure follow the Elastic plan. Proposed specific tables: `servicenow_app_mappings`, `servicenow_identity_links`, `external_record_links`, `external_record_snapshots`, `integration_event_inbox`, `integration_command_outbox`, `communication_batches`, `communication_deliveries`, `external_approval_links`.

External identity key = instance + table/type + sys_id. Link key includes Resolve app + Quackback ticket/conversation. Cardinality: proposed one primary active INC link per QB ticket; many QB tickets may link to the same INC. Optional secondary links and their UX require a later decision. Store source version, mapping revision and last reconciled state. Do not create cross-database foreign keys.

Proposed Resolve routes (new contracts):

- `GET /api/apps/{appKey}/tickets/{ticketId}/service-management` returns authorized linked record, SLAs and source status.
- `GET /api/apps/{appKey}/service-context` returns CI/change/on-call summaries.
- `POST /api/apps/{appKey}/tickets/{ticketId}/external-links` creates a reviewed link.
- `POST /api/integrations/servicenow/operations` accepts an allowlisted command with app/object IDs, expected source version, idempotency key and approved parameters.
- `GET /api/integrations/operations/{id}` returns per-stage authoritative/uncertain results.
- `POST /api/integrations/servicenow/events` is optional, strongly authenticated, size-limited event ingress. Events invalidate; they never grant authorization.

Validate record access at direct-ID reads, writes, exports and attachment access. Do not accept arbitrary customer identity from the browser. Capability examples: service-context read, case read, work-note write, parent-link, assignment, approval decision, paging, knowledge-draft and communication send. Map each to source ACLs and app/object policy.

### Confirmed incident-create and work-note flows

**Create and link:** from an authorized Quackback support ticket, search for existing incidents first, then offer explicit creation. Prefill only approved fields (short description, sanitized description, mapped service/CI and permitted impact/urgency); validate instance-required fields server-side. Do not copy full chat history or attachments automatically. Show the prospective incident and source ticket before submission. Source-side operation-key uniqueness must ensure one INC for a retried creation. Record its sys_id and number before completing the Resolve link. If creation succeeds but linkage fails, show the created incident and resume linkage; never create another incident to recover. Without a reliable lookup/dedup contract, creation stays disabled.

**Append internal work note:** make internal visibility explicit in the composer and confirmation. Require access to both linked objects and the work-note capability; validate the permitted incident and sanitize content. Append through the approved journal API/adapter rather than rewriting journal history or posting a customer comment. Persist an operation key and immutable text hash; retries must return the original receipt without appending again. Ambiguous completion remains pending reconciliation. Test the actual instance’s notification rules: internal notes must not accidentally send customer-facing messages. Human and technical executor attribution must follow section 4.

## 7. Durable synchronization and mutation contract

Prefer a source outbox with event ID, record ID/type, version, changed-field classification and timestamp when the ServiceNow team can build it. Otherwise poll with an overlap window and stable `(sys_updated_on, sys_id)` ordering, deduplication and periodic full reconciliation. This is eventually consistent; same-timestamp changes/deletions need explicit coverage and tombstones or authoritative rereads. Do not claim polling captures every transition.

Initial targets: 60-second visible context refresh; immediate source recheck before writes; source-event accelerated updates where supported. Surface stale state and last success. Define production budgets after discovering API limits and volume.

Each command carries operation ID, payload hash, app, mapped actor, expected source revision and policy revision. The ServiceNow adapter must validate authorization and source version and durably reserve a unique operation key with the mutation, or supply an equivalent recoverable source-side workflow. A pre-read followed by an unconditional Table API PATCH is not compare-and-swap. Verify transaction/locking behavior in the actual ServiceNow platform; do not assume PostgreSQL semantics apply there.

States: queued → executing → succeeded / rejected / uncertain; retryable failure is distinct from confirmed rejection. Timeouts and malformed success remain uncertain until lookup by operation ID. Never blindly retry journal append, paging, case creation or notification. Retain dedup records beyond the maximum retry horizon. Late events cannot regress newer snapshots; stamp origin and operation ID to prevent note/status echo loops.

No distributed transaction spans ServiceNow and Quackback. Represent stages separately, commit intent before remote calls, persist receipts, and reconcile. A source write succeeding while QB note delivery fails is partial completion, not failure of both. Retrying resumes the missing stage only.

## 8. Incident linkage and optional later communications workflow

1. Build candidates from allowed open records plus mapped app/service/error/time evidence. Display why each matched, confidence limitations and existing parent. A differing error code is an exclusion hint, not the sole rule.
2. Agent selects an immutable recipient snapshot and reviews the approved communication revision, channel, affected app and intended record relationship. Recheck permissions/source versions immediately before each write.
3. Link the Quackback ticket and ServiceNow INC through Resolve’s explicit external-record link. If a backlink is written into ServiceNow, use the approved adapter/custom relationship or work note; do not pretend the QB ticket is a ServiceNow task or write its ID into the task `parent` field. Do not create a new incident when a verified existing parent is selected.
4. Track link and message delivery separately per recipient. Default to Quackback as the customer channel to avoid duplicate emails from both systems. ServiceNow work notes remain internal. Explicitly configure/suppress overlapping notifications with the ServiceNow owner.
5. Later incident updates create a new reviewed communication batch with dedup key per recipient/message revision. Do not imply automatic transmission merely because a parent changed.
6. Resolution prompts review of linked cases by default. Prototype auto-close/reopen behavior requires owner approval, source lifecycle support, exceptions for unresolved individual issues and race tests. A resolved incident does not prove a customer's individual case is resolved.

Customer wording such as “your account is safe” or “we will reverse automatically” requires approved operational evidence and an actual fulfillment process. The integration cannot turn those sample promises into behavior. Banner publication, if requested, uses existing broadcast contracts as a distinct approved operation, not an accidental side effect of incident linking.

## 9. Optional later escalation and approvals

ServiceNow group membership may inform eligibility but must intersect Resolve capability, Quackback object access and the approved action policy. Resolve's current tier range and business executor remain unchanged until explicitly redesigned.

In linked-record mode, ServiceNow reassignment updates only the ServiceNow record. Any QB escalation is a second explicit authorized operation and must use QB's existing invariant-preserving contract. The UI reports the state of both.

Approval binds exact app, target, ticket, action, inputs hash, evidence revision, policy revision and expiry. Enforce requester/approver separation where required, current eligibility at decision and at execution, revoked-user denial, and source optimistic concurrency. A ServiceNow approval is not itself an executed refund or freeze.

Reject-and-propose-an-alternative creates a new action request with its own authorization; it must not reuse a freeze approval to execute a reversal. Changed target/inputs/configuration invalidate the old binding. Asking for information leaves execution blocked. Reassignment must be tested against SLA pause/reset rules in the actual instance, not promised solely by avoiding writes to SLA fields.

## 10. Security, accessibility and retention

All writes have durable actor/technical-executor attribution, before/after projection, app/object IDs, operation ID and outcome. Sanitize HTML/journal content, validate attachments, and exclude secrets and unrestricted record dumps from logs. Public comments and work notes use separate contracts and unmistakable composer labels; never infer visibility from text.

Cache per app plus permission context; revoke cached access when source/Resolve entitlements change. Source ACL failures fail closed. Exports/evidence require explicit permission and retention. Propose 24h normalized cache, 30-day diagnostic event retention and organization-governed audit retention, subject to approval. Preserve legal holds without making deleted/redacted source content available to unauthorized viewers.

Follow Resolve's WCAG 2.2 AA gate: accessible case strip, text alternatives for timelines, field labels, full keyboard selection in bulk-link dialogs, per-item error summary, focus restoration and restrained live announcements. No color-only priority/state. Test screen readers and reflow alongside axe; do not rely on the supplied mockup's accessibility.

## 11. Delivery and test gates

**S0 — ownership and instance contract discovery.** Resolve architect + ServiceNow platform owner inventory version, modules/license, tables, domain boundaries, ACLs, OAuth, identity mappings, schedules and notification rules. Apply the confirmed separate ownership contract. Exit: real sanitized fixtures and allowed/denied calls, field ownership matrix in prose/contract schemas, approved network route and scoped-app ownership.

**S1 — read-only incident context.** App mappings, adapter, cache worker, INC status/assignment/SLA panel and source deep links. Changes/ownership require the selected optional modules. Knowledge/CSM/on-call panels are later opt-ins, not required baseline. Exit: no false zeroes, stale state clear, direct-ID/field ACL negatives pass, no writes triggered by reads.

**S2 — controlled linking, incident creation and work notes (confirmed scope).** Implement source-side dedup/version fencing and real actor attribution for all three operations. Incident assignment remains a separately approved expansion. Exit: simultaneous operators produce conflict rather than lost update; timeout after commit reconciles; append occurs once; audit survives restart. Broad admin credentials are not acceptable evidence.

**S3 — incident coordination.** Candidate matching, recipient snapshot, approved communication, per-item status, source event ingestion/recovery. Exit: partially linked batches recover, duplicate/late events do not duplicate messages, withdrawn recipients are respected, concurrent replies are not auto-closed. Auto-close/reopen remains gated by a separate decision.

**S4 — approvals and advanced workflows.** Depends on confirmed ownership contract and an approved executor contract. Add policy-bound approval, reassignment, on-call paging and knowledge drafting in independently enabled slices. Exit: separation of duties, revoked approver, stale snapshot, changed action and SLA preservation tests pass.

**S5 — rollout/upgrade qualification.** Run cross-domain and cross-app tests; escaped encoded-query injection; journal XSS; 429 and outages; crash after each external write; notification duplication; source deletion; group membership drift; expired OAuth; concurrent source edits; DST/business schedule/paused SLA; restored checkpoint; module uninstall/version change. Replay real instance fixtures and run a nonproduction source upgrade before production change.

Canary one app with read-only permissions, then enable one mutation family at a time. Connector kill switch stops new writes while uncertain operations remain visible/reconcilable. Rollback retains mappings/audit and disables affected commands. Runbook assigns source-side and Resolve-side on-call owners and lists manual reconciliation procedures. No production readiness claim until actual instance tests and accessibility evidence exist.

## 12. Dependencies and upstream upgrade safety

Most changes belong in Resolve and the scoped ServiceNow adapter. Any missing QB lookup/link/idempotent-note/assignment API is a separately inventoried fork contract with authorization and upgrade tests; no QB database writes from Resolve. Cross-reference documents 09–11 for existing gaps. Source-dependent worker code does not migrate into the QB tree simply to share models.

Version adapters and fixture schemas independently. An unsupported source release disables writes with an actionable error. Keep UI separate from ServiceNow numeric state values and table internals. Rehearse populated mappings, pending commands, approvals, communications and source permissions on both ServiceNow and Quackback upgrades.

## 13. Owner decisions

1. Confirmed: Quackback owns support tickets and ServiceNow owns INC incidents; Resolve links them. Proposed link cardinality is one primary active incident per support ticket—are secondary simultaneous incident links needed?
2. Owner confirms current versions and reachability. Discovery records the exact build and enabled modules; only ITSM incidents are baseline. Which optional modules should be included in the later integration?
3. Reachability is confirmed; which authentication method and scoped-adapter deployment process should the platform team provide?
4. Should agents write with delegated identity, or is service-account execution with explicit human attribution acceptable?
5. Which system sends customer communication, and who approves incident wording and recipient selection?
6. Should incident resolution notify agents to review their linked Quackback tickets? Default: suggest review, preserve independent ticket lifecycle.
7. Is ServiceNow group membership authoritative for approval eligibility, and is an existing policy engine required?
8. Incident creation and internal work notes are confirmed alongside incident context/linking. Which additional later slices are wanted: paging, knowledge drafting or approvals?
9. What retention, app/domain boundaries and API volume/rate budgets must be enforced?

These questions are recorded here rather than treated as approved defaults. Read-only implementation may proceed after S0 connectivity/ACL gates; state-changing contracts depend on the relevant answers.
