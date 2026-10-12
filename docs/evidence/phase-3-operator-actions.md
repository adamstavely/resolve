# Phase 3 evidence — operator actions and the live inbox

Status: 2026-10-12. Built and tested against the development mock fleet. The mock implements the gap-fixed action
and change-feed contracts (`packages/contracts/src/operations.ts`); the Quackback fork does not provide them yet.

## What exists

- **Recorded actions** (`apps/api/lib/operations.ts`, migration 0004):
  - Every action is stored as an `operations` row before dispatch, and each state change is appended to `audit_events`.
  - The audit holds the human, the app, the target and the tenant record id.
- **Full audit coverage** (owner decision; `apps/api/lib/audit.ts`, migration 0005):
  - Every read is audited (session, apps, dashboard, lists, opening a ticket or conversation, connection checks, stream start and end, audit and people searches).
  - Every refusal is audited: unauthenticated, missing capability, cross-origin, and unavailable or incompatible apps.
  - The full text of every reply and note is stored on the operation's first audit transition, sealed and bound to its event id.
  - Audit readers see the text on the Audit page, which filters by conversation and ticket actions, reads, refused requests, sign-in, connections, access changes and app administration.
  - Evidence: `tests/browser/audit.spec.ts`, `tests/database/operations.db.test.ts`.
- **Write semantics:**
  - **Replies and notes** are keyed by a client-generated operation id, which is also the tenant operation key.
    Reusing an id with different content is refused, both in Resolve and in the tenant.
  - **Assignment and status** carry the version the user saw. A stale version is refused (`CONFLICT`, "refresh and try again").
- **Outcomes:**
  - "Not sent" (the request never reached the tenant) is a failure that is safe to retry.
  - A timeout, server error or lost response is **uncertain** and is never retried automatically.
  - For keyed writes, the user can **Check result**, which reconciles through `get_operation_result`. They can also **Retry**,
    which reuses the same key so the tenant replays rather than sending twice.
- **Independent permissions:** Resolve checks capabilities, and the tenant checks scopes, role and object visibility again.
  A tenant refusal is recorded as `denied`.
- **Live inbox:**
  - **Stream:** `GET /api/inbox/stream` long-polls each monitored app's content-free change feed with the person's own grant.
    The browser re-reads changed items with its own authority.
  - **Recovery:** the SSE id carries each app's cursor, so a reconnect resumes where it stopped; an expired cursor triggers a resync.
  - **Revocation:** the session is re-checked before every poll, so sign-out, blocks and directory disables end the stream.
  - **Idle apps** are monitored only on request.
- **Console:**
  - **Inbox:** a single page that replaced the separate conversations list.
    - **Live open queue:** an app-wide service powers it, so new chats are announced politely on any page and focus never moves.
    - **Status filters:** snoozed, closed and all are read on request, with per-app "Load more".
    - **Thread actions:** assign, snooze, close (confirmed) and team mark-read, plus the composer with sending, not-sent and not-confirmed states.
    - **Deep links:** `/inbox/:app/:id`; `/conversations` links redirect.
  - **Inbox count:** the nav item shows the number of unread open conversations (the shared team watermark). It shows "+" and "at least" while more pages exist.
  - **Ticket page:** reply and note, assignment, and status, with confirmation before resolving.
  - **Navigation:** the Home and Component check items are gone; the logo goes home and `/components` remains reachable directly.

## Exit criteria (plan 00)

| Criterion | Evidence |
|---|---|
| Audit correlation to the human and the tenant record | `tests/browser/inbox.spec.ts` › a reply is sent as the human…: the tenant message names Sam, the `pending` row carries the message text, and the `succeeded` row carries the tenant record id. `tests/database/operations.db.test.ts` |
| Uncertain outcomes visible | inbox.spec › a lost response is shown as not confirmed… and › check result reconciles…: a fault-injected lost response shows "Not confirmed" |
| No automatic retry of non-idempotent actions | The same tests show the tenant has exactly one copy after the lost response and still one after a user retry. `toApi` never offers an automatic retry |
| Tenant permissions rechecked independently | inbox.spec › the tenant rechecks permissions…: Bo is an agent in Resolve but an observer in HR, and HR refuses his reply (`denied`, `FORBIDDEN`) |
| Confirmation for destructive work | Closing a conversation and resolving a ticket both go through a confirmation dialog, which defaults to the safe choice and returns focus |
| Concurrent agents | inbox.spec › another agent's assignment appears live…: Ada's assignment updates Sam's open thread, and Sam's stale version is refused |
| Access changes end live access | inbox.spec › blocking a person closes their live stream |

## Attachments (plan 09; target `upload_file` v2, `get_attachment` v1)

- **Upload** (`POST /api/apps/:app/uploads`, multipart; `apps/api/lib/fleet/files.ts`):
  - **Request checks:** same-origin only, with `chat.reply`/`chat.note` (or the ticket equivalents).
  - **File checks:** Resolve takes the type from the extension, never from what the browser claims, and checks it against
    the file's signature. Text types must be valid UTF-8 without NULs. The size limit is 5 MB, and SVG, HTML and executables are refused.
  - **Tenant checks:** the tenant checks the policy again, scans the file (the mock refuses the EICAR test file), and binds the upload
    to the uploader and its conversation or ticket. Unattached files expire after an hour.
  - **Retry:** an upload key makes a retry return the same file rather than a second copy, so a "not confirmed" upload can be retried safely.
- **Sending:** the reply/note carries up to ten file ids, which are part of the operation's payload hash.
  The tenant attaches a file once, only for its uploader and target. The composer keeps Send disabled while a file is uploading or has failed,
  so a failed upload can't turn into a reply that silently lacks its file.
- **Download** (`GET /api/apps/:app/{conversations|tickets}/:id/attachments/:file`):
  - **Named parent:** the request names its parent, so a guessed file id under another conversation is not found.
  - **Response headers:** always `Content-Disposition: attachment`, `nosniff`, `CSP: sandbox`, `no-store`, with the type limited to the policy list.
  - **No direct access:** there's no tenant URL or credential in the browser.
- **Audit:** uploads (name, type, size, file id) and downloads are audited; the message's file ids are in the operation's summary.
- Evidence: `tests/browser/attachments-presence.spec.ts`, `tests/attachments-presence.unit.test.ts`.

## Typing and presence (plan 09; target `signal_activity`, `get_conversation_activity`, `get/set_availability` v1)

Presence is never implied by having Resolve open or the stream connected (QB-CHAT-3). Every signal is explicit and short-lived.

- **Viewing:**
  - **When it's sent:** while an agent has a conversation open and the page is visible, the console signals `viewing` (refreshed every 20 s; the lease is 30 s).
  - **When it stops:** `stopped` is sent on leaving, on hiding the tab, or on closing the page (`keepalive`).
- **Typing:** a customer reply signals `typing` (8 s lease, refreshed every 4 s while typing, ended by idling, sending, clearing or switching to a note).
  **Writing an internal note never signals typing**, so a customer can't see that a note is being written.
- **What agents see:** the thread shows who else is viewing or writing a reply, and whether the customer is online or typing.
  This is a polite status line that never moves focus.
- **Delivery:** changes arrive over the existing stream as content-free `activity` events, which are emitted only when what others see changes.
  The browser re-reads activity only for the conversation it has open.
- **Availability for routing:**
  - **The control:** a toggle button in the top bar (`aria-pressed`, `mixed` when only some apps confirmed), with per-app results.
    The default is away. Monitoring the inbox doesn't make an agent available.
  - **Sign-out:** sets the agent away in every connected app (best effort, 2 s). A closed browser leaves its session open until it idles out,
    so "your last session" can't be detected reliably.
  - **Audit:** each app's result is audited under **Chat availability**.
- New capability `chat.availability` (fleet-agent and fleet-admin). Observers can neither signal nor set availability.
- **Fork requirements:** QB-CHAT-8 (no typing/viewing tools) and QB-CHAT-3 (availability is a side effect of the stream today).
  The tenant must also drop an agent's availability when their grant is revoked or their directory account is disabled, because Resolve can no longer call it then.

## Load and freshness (plan 09: "an explicit freshness target established by load testing")

**Tools:**
- `tools/load/stream-load.mts` signs in N sessions over HTTP, opens one stream per session, and has customers write in at a steady
  rate.
- **What it measures:** delivery latency from tenant commit to event received, missed deliveries, API memory and CPU,
  PostgreSQL transactions and row writes, tenant tool calls, and tenant calls made after every stream has closed.
- `tools/load/stream-harness.mts` runs the stream handler in a bare Node server, so its own cost can be measured apart from the Next.js dev server.

**Setup:** local loopback on one laptop, two tenants, two people, 2 customer messages/s (each a new conversation), 30 s per run.

| Stream handler | Streams | Missed | p50 / p95 / p99 latency | Peak memory | DB row writes/s | Tenant calls/s per app |
|---|---|---|---|---|---|---|
| Previous commit (harness) | 200 | 0 | 14 / 22 / 25 ms | 366 MB | 390 | 171 |
| Previous commit (harness) | 400 | 0 | 18 / 32 / 123 ms | 434 MB | 756 | 343 |
| Current (harness) | 200 | 0 | 13 / 22 / 25 ms | 322 MB | 24 | 171 |
| Current (harness) | 400 | 0 | 20 / 34 / 37 ms | 440 MB | 28 | 343 |
| Current (harness) | 800 | 0 | 31 / 53 / 58 ms | 579 MB | 50 | 692 |
| Current (Next.js dev server) | 200 | 0 | — / 45 / 51 ms | 766 MB | 12 | 171 |

**What load testing found and fixed:**
- **Grant lock on every poll:** every tenant call took a row lock on the person's grant in a transaction, even with a valid token.
  This serialised all of one person's streams and calls. Valid tokens are now read without a lock; only a refresh locks
  (`accessToken`, concurrency still covered by `grants-directory.db.test.ts`). At 400 streams, p99 latency fell from 123 to 37 ms.
- **Session write on every poll:** each stream poll updated the session's `last_seen_at`. The revocation check before every poll is now
  read-only (`sessionStillValid`), and activity is recorded at most once a minute. DB row writes fell from about one per poll
  (390/s at 200 streams) to background levels (24/s, mostly audit and test sign-ins).
- **Long-poll cleanup:** tenant calls cleared their timeout only when it fired. They now clear it when the call settles, and closing a stream
  cancels its in-flight long polls instead of letting them run up to 20 s.
- **Writes to a disconnected stream:** a failed write now ends the stream.
- **Orphaned polling:** every run checks that no tenant call happens after all streams close (`tenantCallsAfterClose: 0`).
  A harness that didn't cancel the response body on disconnect showed what happens otherwise: orphaned loops kept polling tenants with people's grants.
  A server that doesn't propagate disconnects (cancel the response body, abort the request) must not host this route.
- **Memory:** the handler returns to its idle heap after each run (20 → 24 MB, three runs of 200 streams), so it has no leak.
  The Next.js dev server keeps per-request state (about 4 MB per long-lived stream and growing across runs).
  Load numbers therefore come from the harness, and production capacity must be confirmed on the production build behind TLS.

**Freshness target (proposed):** new messages visible within **2 s at p95**, with a degraded indicator when an app's monitor isn't
`live`. Measured locally, p95 is 34 ms at 400 streams and 53 ms at 800, before real network and tenant latency.

**Capacity:** cost grows with streams × changes. Every change in an app wakes every monitoring agent's long poll for that
app. Each wake-up costs:
- one tenant call;
- two indexed PostgreSQL reads (session check and grant).

This is the price of per-human authorization (no service principal), and capacity planning should use it. For example, 400 agents and
1 change/s per app means about 400 tenant calls/s per app and 800 reads/s. If that's too much, the fork-side fix is a per-person change feed that
covers several apps, or a change hint pushed to Resolve that the agent then confirms with their own read. Polling less often would lose freshness.

## Not yet done

- **Real environment:** production build, TLS, real network latency and the real fork's change feed. The mocks implement the target contracts.
- **Attachment downloads in the fork** (QB-FILE-1), **upload binding** (QB-FILE-2), **typing/presence tools** (QB-CHAT-8) and **explicit availability** (QB-CHAT-3).
- **Personal drafts:** drafts are kept in memory only, per plan 09. Durable drafts need an approved retention policy.
- **Unread count:** it covers loaded open conversations only. A tenant-side unread total would make it exact; that belongs in `get_support_dashboard` or a new aggregate.
- **Audit volume:** viewing signals add about 3 audited requests per minute for each open thread. Retention (plan 05, question 7) should account for it.
