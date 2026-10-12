# Resolve code review — 12 October 2026

Reviewed published `main` at **7c31f1c10320898f261b2bf44f33403f6d663d7f**. Origin was fetched and the checkout fast-forward checked. The review began at `0d036bc`; another editor then committed broadcasts, Elastic E0–E5 and the ticket layout changes. Those additions are included in this report. This is a review, not a remediation change.

**Verdict: substantial, working development implementation; not ready for production or a claim of complete WCAG 2.2 AA conformance.** The architecture is viable. Existing tests pass many useful workflows, but important authorization, crash-recovery and telemetry-interpretation cases remain incorrect. The first release also still needs real-provider and deployment qualification.

P1 means fix before shared production use of the affected feature. P2 means correct before declaring the feature complete. Reproductions below demonstrate current erroneous behavior; a passing reproduction means the defect was reproduced, not that the implementation is correct.

## Findings

### R01 — P1: evidence-capture retries bypass object authorization

In [evidence.ts:46](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/evidence.ts#L46), an existing request ID returns its snapshot after checking only the creator. It does not compare application, object kind, object ID or refresh predecessor, and returns before `subjectContext` checks the human's current tenant access. [captureResponse](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/subject-http.ts#L37) subsequently loads and returns the old snapshot directly; it does not use the authorization performed by `visibleSnapshot` on normal snapshot reads.

A person who captured evidence and subsequently lost access to that ticket can replay their original request ID through an application route they can still access and obtain the old evidence. Reusing the ID for a different ticket also silently returns the wrong evidence. The review-only test confirmed the early return with exactly one database lookup and no object check.

**Correction:** bind the key to creator, app, object kind/ID and capture parameters. Reject mismatches. Re-check access to the stored snapshot's actual object on every replay, including expiry. Test permission removal between capture and replay and cross-app/target key reuse.

### R02 — P1: IPv4-mapped IPv6 bypasses Elastic's forbidden-address checks

[addressAllowed](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/elastic/client.ts#L53) recognizes mapped IPv4 only in dotted notation. Hex forms such as `::ffff:a9fe:a9fe` and `::ffff:7f00:1` fall through as allowed even with loopback disabled. These represent metadata/link-local and loopback addresses respectively. A review-only test confirmed both return `true`, while `169.254.169.254` returns `false`.

The hostname allow-list remains a prerequisite, so this is not an unrestricted arbitrary-URL endpoint. Nevertheless, it defeats the promised address restriction when an approved name resolves to a mapped forbidden address; URL normalization also commonly produces the hex form.

**Correction:** normalize IPv6 to bytes, unwrap IPv4-mapped addresses, then apply the IPv4 policy. Test compressed/expanded/mapped representations through the connection path, not only string examples. Retain DNS pinning, TLS verification and the hostname allow-list.

### R03 — P1: operation keys are not bound to an application

[operations.ts:40](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/operations.ts#L40) hashes operation, target and arguments but not app identity. [The replay check at line 72](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/operations.ts#L72) compares only user and hash. A duplicate key on another app can return the first app's result. For an uncertain keyed operation, [runAction](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/fleet/actions.ts) can dispatch that stored operation through the second app's context, leaving execution and audit attribution inconsistent.

A disposable-database reproduction created an operation for app A, replayed the same key and payload for app B, and received A's row with `created:false`.

**Correction:** bind app, tool, target type/ID and normalized payload into immutable operation identity; explicitly compare stored app before replay or dispatch. Test same target IDs across two apps, both completed and uncertain operations.

### R04 — P1: directory revocation can commit without ever reaching the tenant queue

[applyDirectorySnapshot](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/directory.ts#L64) commits the user's state/session revocation, then calls `recomputeUser` in a separate transaction. A crash or database failure between these steps leaves Resolve disabled but no tenant denial job. On retry, the same observation is classified `unchanged`, so no recomputation occurs. The absence path has the same gap. The dispatcher drains existing jobs; it does not repair missing desired-state work.

**Correction:** transactionally enqueue recomputation with the authoritative user update, or update desired entitlements in that transaction. A durable reconciler must finish interrupted work independent of whether the next observation changes state. Test killing the process immediately after the directory transaction and continuing to use an existing tenant session.

### R05 — P1: directory polling cannot remove a privileged group from an active user

[The directory schema](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/directory.ts#L13) accepts subject, active flag and version only. Group-derived bundle replacement happens during [sign-in](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/auth/repository.ts#L66). An employee who stays active but loses an administrator/support group retains the cached bundle and associated tenant entitlement until another sign-in changes it. Incrementing their directory version does not remove the group.

**Correction:** ingest authoritative group/entitlement membership, reconcile claim-owned bundles and queue resulting tenant changes. Keep manual grants distinct where intended. Test group removal while the person continues using existing Resolve and tenant sessions without signing in again.

### R06 — P1: stale full directory snapshots can revoke newer state

[The complete-snapshot absence branch](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/directory.ts#L72) does not order snapshots by source checkpoint/observation time. It disables enabled identities absent from the supplied list regardless of a more recent per-user observation. The same-version branch also permits conflicting active flags to change state.

The database reproduction applied an active version-20 observation at 12:00, then an older complete empty snapshot at 11:00. The user became disabled. Concurrent or delayed full polls can therefore undo newer directory state; an absence marker also does not advance the user's source version.

**Correction:** serialize authoritative snapshots/checkpoints per source, reject stale complete observations, define equal-version conflict handling, and make absence decisions respect newer user observations. Include delayed full polls, overlapping polls and stale reactivation tests.

### R07 — P1: operator actions can remain pending forever after a crash

[beginOperation](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/operations.ts#L63) commits `pending` before dispatch. A process failure before dispatch or after tenant execution but before completion leaves that state. [runAction](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/fleet/actions.ts) only redispatches `uncertain` or `failed/NOT_SENT`; [reconcile](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/app/api/operations/%5BoperationId%5D/reconcile/route.ts#L21) similarly excludes pending rows. The response maps pending to HTTP 422 with “The action failed,” although execution may have happened.

In addition, [complete](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/operations.ts#L103) updates unconditionally. Concurrent retries can let a late timeout overwrite an already recorded success.

**Correction:** add a durable execution/recovery state machine with leased ownership or equivalent fencing. Reconcile stale dispatched rows using the original tenant key; distinguish never-dispatched from uncertain. Prevent terminal-state regression. Test crashes before send/after commit and two concurrent retries with reversed responses. Evidence-note posting inherits this operation lifecycle and needs recovery too.

### R08 — P1: inbox reconnect can permanently skip part of an event batch

[The inbox stream](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/app/api/inbox/stream/route.ts#L78) advances the app cursor to the batch's final cursor before emitting each individual change. Every emitted change then carries that final SSE ID. If the connection drops after the first event, reconnect resumes after the whole batch and omits the remaining changes.

**Correction:** checkpoint only after all changes represented by the cursor have been delivered, or emit one atomic batch event/per-event cursors. Ensure other concurrent app/monitor frames cannot expose the premature checkpoint. Test disconnect after event one of a multi-event response. Also cover initial snapshot/stream establishment so updates between the list read and cursor acquisition are not lost.

### R09 — P1: switching inbox threads corrupts pending sends and permits stale detail rendering

[Inbox selection](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/console/src/app/pages/inbox.page.ts) clears the shared `MessageSender.pending` while its request can still be in flight. [settle](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/console/src/app/actions.ts#L50) asserts that the pending item exists: successful completion dereferences missing state; failed completion inserts a malformed item into the newly selected thread. A review-only unit reproduction confirmed a pending entry with no operation ID after switching during a failed send.

`refreshSelected` also compares only item ID, not app key, and does not reject older responses. With identical IDs in two tenants, a late read from A can populate B's selected panel. Even within one app, an older response can overwrite a newer one.

**Correction:** isolate pending state by user/app/object, capture the request target, retain unresolved sends across navigation, and cancel or generation-check reads using the complete identity. Apply version ordering to live refreshes. Test successful/failed sends while switching, identical IDs across apps, and reversed read completions.

### R10 — P1: a “verified” receipt does not require evidence from the expected downstream system

[watchReceipts](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/receipts.ts#L52) chooses the first event matching an operation ID and treats anything other than `failure` with no HTTP error as success. It does not require the expectation's service/event kind, and `unknown` plus a missing HTTP status is accepted. [The telemetry query](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/elastic/families.ts#L299) does not restrict the downstream stage either.

A review-only test supplied an `unrelated-service` event with `outcome:unknown` and no status; the observation became `observed`, which the UI describes as mail-relay acceptance. An earlier unrelated failure can conversely override a later relevant success.

**Correction:** define an explicit receiver event contract and validate operation, service, stage, outcome, app/environment and timing. Unknown evidence must stay unverified. Test upstream-only spans, unknown outcomes, unrelated failures and late qualifying downstream events.

### R11 — P1: truncated Elastic results can falsely clear active incidents

[Alert reads](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/elastic/families.ts#L97) request only 100 hits, and [case reads](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/elastic/families.ts#L168) request 50 cases without pagination. [The poller](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/poller.ts) treats each successful response as a complete enumeration and marks previously active issues missing from that page recovered/closed. Dropped records from schema validation are likewise not propagated as an incomplete enumeration.

With 101 matching alerts or 51 cases, a still-open issue can fall off page one and be declared cleared. Subscriptions then report that it cleared; health counts also understate the source. Schema drift can produce the same false resolution.

**Correction:** paginate exhaustively with a bounded explicit completeness result, or leave unseen issues unresolved when results are truncated/invalid. Separate authoritative recovery from absence in a partial listing. Test boundary counts and malformed rows for previously known active issues.

### R12 — P1: an open dashboard can remain “Operational” after the source becomes unavailable

[ObservabilityService](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/console/src/app/observability.service.ts#L45) rereads only on events and stores server-computed health state. It schedules no expiry transition or periodic recovery read. The poller's network-failure path backs off without publishing a new snapshot/event. If Elastic or the integration worker stops while the SSE connection stays healthy, the browser can display its old green state indefinitely even though a fresh API read would correctly say stale.

There is also an initialization/reconnect gap: [subscribeObservability](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/notify.ts) returns before PostgreSQL `LISTEN` completes; the route emits `ready` immediately. On listener failure, the gap callback fires before reconnection, with no corresponding ready callback after the new subscription is established.

**Correction:** await listener readiness before triggering the authoritative read, signal completed reconnection, and schedule client expiry or bounded background refresh based on provenance. Test a healthy open page with all source polls stopped and no other events, and a commit during listener reconnection.

### R13 — P2: telemetry context is not consistently bound to environment and configuration revision

[subjectContext](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/subject.ts#L70) selects the alphabetically first active environment for an app; receipt monitoring selects an unspecified first mapping. The subject-cache key omits environment and connection identity/revision. [Health reads](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/integrations/observability.ts#L44) accept the latest historical snapshot without requiring it to match the current mapping/connection revisions.

When an app has production and test mappings, or a connection/mapping changes, context or health can be presented from the wrong environment or previous configuration. Reactivating a checked new mapping does not make an old healthy snapshot evidence for its new selectors.

**Correction:** make environment an explicit resolved identity for each workflow; include it and connection/mapping revision in caches and queries. Require a matching snapshot or show “waiting for first check.” Test two environments with the same revision and subject, credential/config changes, and mapping replacement before a fresh poll.

### R14 — P2: broadcast delivery audit and archive recovery are incomplete

[settle](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/broadcasts.ts#L222) commits the delivery-state update and then writes audit separately. A failure between them leaves a settled delivery with no required transition audit; ordinary recovery no longer selects it. Archive delivery has the same split.

[Archive](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/broadcasts.ts#L329) retries by announcement ID and old expected version, without an archive operation key/result reconciliation. If the tenant commits but its response is lost, the next attempt can be reported as a local-edit conflict despite having archived successfully. Publication's key-based reconciliation does not cover this action.

**Correction:** commit local transitions and audit together with fenced completion. Give archive an idempotent/reconcilable contract, or prove current archived state before classifying a version conflict. Test audit insertion failure, accepted-but-response-lost archive and competing recovery attempts.

### R15 — P2: request bodies are buffered before enforcing their real size

[uploadAttachment](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/fleet/files.ts#L64) relies on optional `Content-Length`, then parses the entire multipart body before authentication/authorization and the actual file-size check. [jsonMutation](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/http.ts#L10) also parses an unbounded JSON body before schema validation. Omitting Content-Length bypasses the preliminary upload bound; later checks do not undo memory already allocated.

**Correction:** enforce a streaming byte limit and authenticate before expensive parsing; document and test any trusted ingress limit as defense in depth. Test chunked oversized requests and concurrent uploads. Apply a total deadline, not only idle socket timeout, to bounded external clients as well.

## Additional correctness and maintainability observations

- **Assignment identity:** “Assigned to me” and the inbox unassign control compare `assigneeName` to the Resolve display name. Names are not unique and may differ between IdP and tenant. Use the per-tenant principal ID already represented in the contracts. See [inbox.page.ts](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/console/src/app/pages/inbox.page.ts).
- **Lifecycle status ordering:** [fleet job refresh](https://github.com/adamstavely/resolve/blob/7c31f1c10320898f261b2bf44f33403f6d663d7f/apps/api/lib/fleet-admin/jobs.ts#L118) fetches status before locking, then records it without a response version or checking whether a later response has already settled the row. Two pollers can regress a completed stage. Add monotonic worker status versions/CAS and a reversed-response test.
- **Wizard focus:** `go()` calls `.focus()` on `#step-title`, an H2 without `tabindex`. The isolated keyboard check confirmed the intended heading did not receive focus (focus was on the H1 in the tested transition). Make the intended target programmatically focusable and test step navigation. This alone is not sufficient evidence to declare a specific WCAG failure: focus may remain usable on another control, so assess the complete interaction.
- **Data retention:** expiry gates hide old evidence, but a retention policy also needs physical deletion/hold handling for stored snapshots, summaries and full-content audit records. Verify this in deployment rather than equating an expired read with erasure.

## Completeness against the plans

- **Foundation and identity:** Angular/Next.js/PostgreSQL, OIDC, per-human tenant grants, capability checks and sealed local credentials are implemented. Production IdP/directory adapters, correct ongoing entitlement reconciliation, KMS/secret lifecycle and deployed SSO verification are not proven complete.
- **Fleet dashboard:** KPI aggregation, missing-app coverage, partial results, activity and explicit dormant loading are implemented against the mock contracts. The tests correctly distinguish unavailable data from zero. Real Quackback KPI/tool implementations and production data-definition parity remain release gates.
- **Unified inbox/operator actions:** chat/ticket reads, replies, notes, attachments, assignment/status, presence and live invalidation exist. Correct recovery and event delivery need R03/R07–R09. Versioned tenant tools are advertised by mocks; the contract inventory explicitly records missing/extended Quackback APIs.
- **Application onboarding/fleet administration:** wizard, review/pilot gates, allowlisted worker commands, role jobs, suspension/resume and migration views exist. The actual privileged fleet worker/infrastructure is still a mock deliverable, not proof that AWS, tenant migrations or real provisioning work.
- **Broadcasts:** committed in `c8c862c`, with all-app/selected-app targets, scheduling, review, delivery tracking and publication reconciliation. Production end-to-end tenant rendering/delivery and R14 remain. Resolve sends content; it does not itself establish accessibility of the real Quackback portal/embed.
- **Elastic:** E0–E4 have code and E5 has local harnesses/drills. It is no longer “plans only.” The checked-in E5 evidence explicitly defers real-cluster performance, exact provider-version fixtures, production credentials/networking, canary rollout and runbooks. R01/R02/R10–R13 prevent treating it as qualified.
- **ServiceNow:** still a later-release plan, appropriately not counted as missing first-release implementation.
- **Production qualification:** no checked-in GitHub CI workflow or production deployment assembly was found in the reviewed snapshot. The code can build, but there is no demonstrated deployed full-system acceptance. Update plan 00's “implementation has not started” and README's phase summary; they no longer accurately describe the implementation.

## Angular and component architecture assessment

The implementation uses standalone components, `inject`, signal inputs/outputs/computed state, tracked template loops, strict compilation, shared contracts and deliberate cleanup in several services. The React/custom-element bridge handles typed properties/events, form association, focus, validation and disconnect/reconnect. These are useful foundations.

The highest-priority Angular issue is request/state ownership, not replacing fetch with a particular library. Use cancellation and request generations, full app/object identity and model versions; ensure late work cannot write into a different page. Keep effects and teardown tied to the component/service lifetime. R09 and R12 are concrete consequences of current gaps.

Maintainability needs improvement: large page components combine templates, form orchestration, HTTP, polling and state machines; split by feature and responsibility. Routes eagerly import every page. Add lazy feature loading and explicit bundle budgets. Only text field, combobox and confirmation dialog are registered reusable shadcn-backed elements; buttons, selects, tables, composer and newer drawers mostly use native/Angular markup. Native semantics are good, but this is partial delivery of the agreed reusable Web Component/component-library layer. Decide the reusable boundary and implement it consistently rather than treating the root custom element as proof that every reusable control meets the contract.

These recommendations use the [Angular style guide](https://angular.dev/style-guide) as guidance, not as a claim that every stylistic deviation is a defect.

## Node/Next.js assessment

Good practices include a supported/pinned Node line, explicit Node route runtime, environment validation, server-side capabilities, exact-origin mutation checks, parameterized SQL, schema-validated provider responses, no browser-held tenant secrets and dedicated workers for privileged jobs. The Elastic client adds hostname checks, DNS pinning, response byte limits and TLS verification.

Production blockers are durable transaction boundaries, idempotency identity, request bounds, telemetry semantics and network-address normalization—not the choice of Next.js. Add monotonic/fenced completion to every retried external operation, transactional queues/audits and bounded cancellation. Keep provider errors out of sensitive logs and make worker failures observable. The current sealer always instantiates the local-key implementation; the documented production replacement needs to exist and be exercised. Review deployment timeouts, connection limits and egress restrictions with the actual proxy/runtime. See [Node's security guidance](https://nodejs.org/learn/getting-started/security-best-practices).

## WCAG 2.2 AA assessment

**Status: useful automated evidence; full conformance not established.** The browser suite includes axe A/AA tags, labelled controls, form errors, keyboard interaction, dialog focus, light/dark themes, 320px reflow and text-spacing checks. Those tests cover selected pages/states and mock processes, not every criterion or every real authentication flow.

The review found the wizard focus-target defect described above. Race-related broken pending controls also need accessible error/recovery testing after R09 is fixed. No blanket statement that the frontend is “fully compliant” is justified by the current evidence.

Before sign-off, complete the plan 06 criterion-to-evidence matrix for full processes: real SSO and recovery; onboarding at each step/error; chat sending/retry/attachments; banner review/scheduling/failure; and Elastic dialogs/evidence. Include keyboard-only completion, NVDA with supported Windows browsers, VoiceOver/Safari, 200% text resizing, 400% zoom/320 CSS-pixel reflow, text spacing, focus visibility/obscuration, 24px target-size rules/exceptions, live announcements and timeout handling. Check all states in both themes. Re-test the actual tenant portal/banner separately; mock rendering does not qualify it.

[WCAG 2.2](https://www.w3.org/TR/WCAG22/) requires conformance across full pages and complete processes, not just a clean automated scan. No screen-reader or deployed corporate SSO certification was performed in this review.

## Verification performed

The latest snapshot was extracted into an isolated temporary directory, with its own lockfile installation and a disposable PostgreSQL 18 database. Mock ports were changed to avoid the developer's active stack. Only development fixture credentials were used. Review-only reproductions were kept outside the working repository.

- Latest type checks and development console build: passed.
- Latest unit suite: **258 passed**.
- Latest PostgreSQL suite: **81 passed**.
- Latest Quackback source-contract suite: **32 passed**, against the pinned `49ea2028773018064d99f37c8e41b7887004b9b2` checkout. This is source-inventory verification, not real tenant execution.
- Latest Playwright/Chrome browser suite: **91 passed**, including the suite’s axe checks.
- Latest optimized Angular and Next.js production builds: **passed**.
- Targeted reproductions: cross-app operation key, stale complete directory snapshot, pending-message thread switch, mapped-IPv6 address policy, evidence replay and false downstream receipt. All six reproduced on the latest code. The wizard focus observation was made on the earlier snapshot; the relevant focus code is unchanged.
- Earlier `0d036bc` snapshot: 200 unit, 56 database, 29 source-contract and 64 browser tests passed, and production build passed. These numbers are historical and are not substituted for the latest suite.

The initial earlier browser run collided with a developer mock port; after isolation was corrected, all 64 passed. That environment failure is not reported as a product defect. Real Elastic/Quackback/SSO staging tests and production network/load tests were not available; the repository's previously recorded load numbers were inspected, not independently recertified.

## Recommended order

1. Repair authorization and directory propagation: R01–R06, with negative/reordered-event tests.
2. Repair action and live-state correctness: R07–R09 and R12, including crash/connection-loss tests.
3. Correct Elastic evidence interpretation/configuration identity: R10/R11/R13; qualify against actual provider fixtures.
4. Complete broadcast recovery/audit and request limits, then production assembly/CI.
5. Run real tenant/IdP/Elastic canaries and the full accessibility acceptance matrix. Only then describe the release as complete or WCAG 2.2 AA conformant.
