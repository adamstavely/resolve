# Plan 15 — Remediation of the 12 October 2026 code review

Status: **owner decisions recorded (12 Oct 2026); awaiting go-ahead to execute. Nothing here has been executed.**

Source: [docs/reviews/2026-10-12-full-code-review.md](../docs/reviews/2026-10-12-full-code-review.md) (reviewed `7c31f1c`).
Every finding was re-checked against the code at `d5ce472` (the same code plus the review document) by reading the cited lines, their callers, migrations and tests, and for R02 by running the function.

## 1. Verdicts

| ID | Review says | Verified | Severity here | Notes |
|---|---|---|---|---|
| R01 evidence replay | P1 | **Confirmed** | P1 | `evidence.ts:47-50` checks only `created_by`; `subject-http.ts:48` returns the row without `visibleSnapshot`. `request_id` is globally unique (`0008.sql:150`). **Extra:** replay of an expired snapshot and two concurrent captures with one id both end in HTTP 500. |
| R02 mapped IPv6 | P1 | **Confirmed (function); exposure overstated** | **P2** | `client.ts:64` unwraps only dotted `::ffff:a.b.c.d`. Hex mapped, expanded, IPv4-compatible and NAT64 (`64:ff9b::/96`) forms pass. DNS answers come back dotted (libuv), so exposure needs an operator-allow-listed IP literal or a NAT64 answer. Still worth fixing properly. |
| R03 operation key/app | P1 | **Confirmed** | **P2** | `operations.ts:40` hash omits app and target type; `:72` compares user + hash only. Same user and same payload required, so there's no cross-user exposure, but results and audit attribution can be wrong. |
| R04 directory → tenant queue | P1 | **Confirmed** | P1 | Commit then separate `recomputeUser` (`directory.ts:70`, `:84`). Retries classify as `unchanged`. No reconciler exists. Also contradicts plan 02 §32 ("atomically … enqueue work"). The same commit-then-recompute split exists in the manual block, bundle grant and sign-in paths. |
| R05 group removal | P1 | **Confirmed** | P1 | Directory schema has no groups (`directory.ts:13-18`). Claim bundles are replaced only at sign-in. Plan 05 §55 left the directory source of group changes open. |
| R06 stale full snapshot | P1 | **Confirmed** | P1 | `observedAt` is stored but never compared. The absence branch has no per-user ordering or lock. Equal-version conflicting flags are applied both ways. Failing closed is transient, but sessions and grants are not restored on re-enable. |
| R07 pending forever / regress | P1 | **Confirmed** | P1 | No sweeper. Reconcile and redispatch skip `pending`. `complete()` updates unguarded, so a late timeout can overwrite success. **Extra:** a concurrent duplicate request for an in-flight id is told "The action failed" (422), with no crash needed. |
| R08 inbox cursor | P1 | **Partially correct** | P1 | Real: the cursor is advanced before per-change frames, every frame carries the batch-final id, and monitor frames from other apps carry it too. The client relies only on Last-Event-ID (no reload on reconnect). A mid-batch cut is a narrow window. The initial load/connect race is real. **Extra:** any detail-read error (including network) removes the row as "no longer visible". |
| R09 thread switch / stale reads | P1 | **Confirmed** | P1 | `inbox.page.ts:269` clears in-flight pending. `actions.ts:53` `!` deref throws on success and inserts a malformed item on failure. `refreshSelected` compares id only, with no generation. **Extra:** the ticket page reuses its sender across ticket→ticket navigation, so pending and Retry leak to the next ticket. |
| R10 receipt evidence | P1 | **Confirmed** | P1 | First event from any service wins (earliest, ascending). `unknown` with no status counts as observed. The query filters only operation id + time. The 200-hit cap is not paginated. |
| R11 truncated Elastic lists | P1 | **Confirmed, understated** | P1 | Alerts `size:100` also include non-active alerts in the window. Cases `perPage:50`. No completeness flag, `dropped` discarded. Absence closes issues. |
| R12 stale "Operational" | P1 | **Confirmed** | P1 | The client re-reads only on events. Poller failure paths publish nothing. `ready` is sent before LISTEN completes, with no ready after reconnect. |
| R13 environment / revision | P2 | **Confirmed** | P2 | First environment alphabetically. The cache key omits environment and connection. Health reads ignore mapping and connection revision. **Extra:** `activeIssues` filters by app only. |
| R14 broadcast audit / archive | P2 | **Confirmed** | P2 | Settle and audit are separate autocommits and settle is unguarded. An archive retry after a lost response becomes a terminal `conflict`. |
| R15 unbounded bodies | P2 | **Confirmed** | P2 | `formData()` / `json()` run before auth. Chunked requests skip the Content-Length check. No limit anywhere else (no middleware or proxy config in the repo). Reachable without signing in. |
| Assignment by display name | obs. | Confirmed | P2 | `inbox.page.ts:104,202,205`, `ticket-detail.page.ts:40`. |
| Fleet job status ordering | obs. | Confirmed | P2 | `jobs.ts:123` reads before the lock, records unconditionally, and can re-settle (duplicate audit). |
| Wizard focus | obs. | Confirmed | P2 | `onboarding.page.ts:71` heading lacks `tabindex="-1"`. |
| Retention purge | obs. | Confirmed | P2 | Only health snapshots are purged. Expired evidence, summaries and audit are never deleted. |
| Docs/CI completeness | obs. | Confirmed | P3 | Plan 00 still says "implementation has not started". The README status is stale. `.github/workflows/` is empty. |

No finding was judged incorrect. Severity changes: R02 and R03 from P1 to P2, for the exposure reasons above. They're fixed early anyway because the fixes are small.

## 2. Work packages

Each package lands as one commit with its tests, all suites green (typecheck, unit, database, contract, browser), pushed only when asked. Migrations continue from `0012`.

### F1 — Authorization and request identity (R01, R03, R02, R15)
Small, high-value, mostly self-contained.

- **R01** `integrations/evidence.ts`, `subject-http.ts`
  - The replay lookup selects `app_key, object_kind, object_id, previous_id, expires_at`. Any mismatch → 409 `REQUEST_REUSED`.
  - Replay responses go through `visibleSnapshot` (tenant re-check plus current restricted capability). Expired or missing → 404/410, not 500.
  - Catch unique violation `23505` on insert and re-read (concurrent capture).
  - Tests (db + browser): access revoked between capture and replay; same id on another app/object; replay after expiry; two concurrent captures.
- **R03** `operations.ts`, `fleet/actions.ts`
  - Include app key, tool and target type in the identity hash, and explicitly compare `existing.app_key` → `OperationConflict`.
  - `runAction` asserts `row.app_key === ctx.app.appKey` before any dispatch.
  - Tests: same key on two apps for a completed and for an uncertain operation.
- **R02** `elastic/client.ts`
  - Parse IPv6 to 16 bytes. Unwrap `::ffff:0:0/96`, `::/96` (compatible) and `64:ff9b::/96`, then apply the IPv4 policy.
  - Byte-compare loopback, unspecified, link-local, ULA and multicast.
  - Unit cases for compressed, expanded, upper-case, hex-mapped and NAT64 forms, plus one test through `ElasticClient` with a stubbed resolver.
- **R15** new `lib/body.ts`
  - Add `readBodyLimited(request, max)`, which streams and aborts with 413.
  - `jsonMutation` (1 MB) and `uploadAttachment` (attachment max + 64 KB) authenticate first, then read through it. `formData()` is parsed from the bounded buffer.
  - `ElasticClient` and the tenant and model clients get a total deadline in addition to the idle timeout (verify each).
  - Tests: an oversized chunked body with no Content-Length → 413 without buffering; unauthenticated oversized upload → 401.

### F2 — Directory and entitlement propagation (R04, R05, R06)
Decision 1 applies: the directory is authoritative for groups.

- **R04**
  - Export `recomputeUserTx(tx, userId)` and call it inside the transactions of the directory change, absence, manual block, bundle grant and sign-in paths. Desired state and job enqueue then commit with the user change.
  - Add a periodic idempotent reconciler to `scripts/fleet-jobs.mts`. It recomputes every user's desired state and enqueues where `payload_hash` differs.
  - Test: fault-inject a throw after the directory commit, replay the same snapshot, and assert a denial job exists.
- **R06** migration `0012`
  - Add `users.directory_observed_at` and a per-source `directory_checkpoints` table.
  - Take an advisory lock per source.
  - Reject complete snapshots older than the checkpoint.
  - Process absence per user under `FOR UPDATE`, skipping users with a newer observation.
  - Treat equal-version conflicting flags as `conflict` (no change, audited alarm). The exception is reactivating a `directory_absent` user, which needs a newer `observedAt`.
  - Tests: an active v20 at 12:00, then an empty complete snapshot from 11:00, leaves the user enabled; overlapping polls; stale reactivation.
- **R05**
  - Extend the directory snapshot contract and mock directory with per-user `groups`, mapped through the same claim→bundle mapping as sign-in.
  - When the version advances, replace `source='claim'` rows in the same transaction, then recompute (R04). Manual grants are untouched.
  - Tests: an active user who loses the admin group loses the bundle in `findSession` without signing in, and gets a tenant job.

### F3 — Operation lifecycle (R07, fleet job ordering, R14)

- **R07** migration
  - Add `operations.dispatch_token` and `lease_until`. Every transition is guarded: no change out of a terminal state, and `complete` matches the dispatch token.
  - `pending` maps to 202 "still in progress", not 422.
  - Add a sweeper to the worker:
    - Stale `pending` with no `dispatched_at` → `failed/NOT_SENT`.
    - Stale and dispatched → `uncertain`.
    - Keyed rows are then reconciled via `get_operation_result`.
  - Evidence-note posting uses the same path.
  - Tests: crash before send; crash after send; two concurrent retries with responses arriving in reverse order.
- **Fleet job ordering** `fleet-admin/jobs.ts`: after the lock, return early if the job is already settled, and add a stage-rank comparison. Test reversed responses.
- **R14** `broadcasts.ts`
  - Run settle and archive-delivery updates with their audit in one `transaction()`, guarded by state and claim.
  - On archive `CONFLICT`/unknown, read `get_announcement_by_key`. If it's already archived, record `succeeded`.
  - `tick` re-drives stale archive states.
  - Tests: audit insert failure rolls back; archive accepted but response lost; concurrent settle and reconcile.

### F4 — Live state in the console (R08, R09, R12, assignment identity)

- **R08** `inbox/stream/route.ts`, `inbox.service.ts`
  - Emit one `changes` event per batch carrying the batch cursor, so the checkpoint is atomic with delivery.
  - Monitor frames carry only committed cursors.
  - On first connect, take cursors before the list read, or re-`load()` once the stream is live.
  - A detail-read failure no longer removes a row unless it's a real 403/404.
  - Test: disconnect after a partial batch, reconnect with the received id, and receive the remainder; also a change between the list read and stream start.
- **R09** `actions.ts`, `inbox.page.ts`, `ticket-detail.page.ts`
  - `MessageSender` captures the target path per send, and pending is keyed by `appKey/kind/id`, so it survives thread switches and isn't shown on the wrong thread.
  - `settle` tolerates a missing entry.
  - Reads use a generation counter plus a full `{appKey,id}` comparison, and ignore a lower `version`.
  - The ticket page clears its view state on target change.
  - Tests: success and failure while switching; identical ids in two apps; reversed reads; ticket A→B navigation.
- **R12** `notify.ts`, `observability/stream`, `observability.service.ts`
  - The bus exposes readiness after LISTEN, including after reconnect. The route sends `ready` only then.
  - The client schedules `reload()` at the earliest `expiresAt`, bounded by poll interval × N, and shows "Out of date" locally once it passes.
  - Tests: stop all polls with the stream open and expect the out-of-date state within expiry; commit a change during a listener reconnect.
- **Assignment identity**: the session and capabilities response carries the user's per-app tenant principal id. Comparisons use `assigneePrincipalId`.

### F5 — Elastic interpretation and configuration identity (R10, R11, R13)

- **R10** `receipts.ts`, `elastic/families.ts`, contracts
  - Add an explicit receiver contract to each expectation (service, event kind/transaction type, environment, required outcome).
  - The query filters on service and environment and is paginated.
  - Selection rules:
    - Success requires `outcome:success` and status < 400.
    - Failure counts only from a qualifying event.
    - A later qualifying success beats an earlier failure.
    - `unknown` stays unverified.
  - Tests: upstream-only spans; unknown outcome; unrelated failure followed by a late qualifying event; more than 200 hits.
- **R11** `families.ts`, `poller.ts`
  - Issue enumeration queries only active alerts.
  - Paginate alerts (`search_after`) and cases (`page`) up to a bounded maximum.
  - `Parsed` gains `complete`.
  - The poller closes absent issues only when the family is `ok && complete`. Otherwise the snapshot is `partial` and unseen issues are left open.
  - Mock Elastic gets more than 100 alerts and more than 50 cases.
  - Tests at the boundaries, plus a malformed row for a known active issue.
- **R13** migration
  - Add `connection_id` to health snapshots (backfilled).
  - Health reads require matching connection id, connection revision and mapping revision, else "waiting for first check".
  - Environment becomes an explicit part of subject, receipt and issue queries: Production by default, Training selectable (decision 2). Migration constrains mapping environments to `production` and `training`; mock data gains a Training mapping.
  - Cache keys include environment, connection and revisions.
  - Tests: two environments at the same revision; a credential or kill-switch revision bump; mapping replaced before a fresh poll.

### F6 — Hygiene (retention, wizard focus, docs, CI)

- **Retention**: a scheduled purge for expired, non-held evidence snapshots and summaries. Evidence purged 30 days after expiry unless held, summaries with it, audit kept 1 year (decision 3). Test that held rows survive.
- **Wizard focus**: add `tabindex="-1"` on `#step-title`, with a keyboard test after Next and after a step button.
- **Docs**: correct plan 00's status line and the README phase summary. Mark plan 14 E5 staging as still open. Add a short "addressed in plan 15" note to the review document.
- **CI**: a GitHub Actions workflow for typecheck, unit and contract tests, the database suite with a Postgres service, and a production build. The Playwright browser suite (Chrome) runs on every push too (decision 4).

### Not in this plan (recorded, not scheduled)
These are architectural recommendations and real-environment qualification, not defects:
- Lazy-loaded feature routes and bundle budgets.
- Splitting large page components.
- Widening the reusable Web Component layer.
- KMS sealer.
- Real IdP, tenant and Elastic canaries.
- The full WCAG 2.2 AA manual matrix (NVDA, VoiceOver, 400% zoom, etc.).

The review is right that these gate production and any conformance claim. They belong with Phase 6 and E5 staging.

## 3. Order

F1 → F2 → F3 → F4 → F5 → F6. F1 is quick and closes the authorization gaps. F2 and F3 are the crash and ordering correctness core. F4 is user-visible live state. F5 is Elastic semantics, which are still mock-qualified only. F6 can be interleaved.

## 4. Owner decisions (12 October 2026)

1. **Directory groups (R05): yes.** The directory feed is authoritative for group membership. Losing a group revokes the claim-derived bundle without a new sign-in. Manual grants are separate and unaffected. A complete snapshot that omits `groups` for a user leaves their claim bundles as they are.
2. **Environments (R13): Production and Training.** These are the two environments Resolve uses for context.
   - Each app has an explicit Production and Training mapping. Other environments are never used for context.
   - Production is the default. The agent can switch the system context, evidence capture and pre-flight to Training.
   - The chosen environment is shown on screen and stored with snapshots, pre-flights and receipts.
   - Receipts use the environment the action ran against: Production unless the app's tenant is a Training instance.
   - Health cards show Production. Training appears on the app page.
3. **Retention: yes.** Expired evidence is purged 30 days after expiry unless held. Summaries go with their evidence. Audit is kept for 1 year.
4. **CI: every push.** The browser suite runs on every push, along with typecheck, unit, contract and database suites and the production build.
