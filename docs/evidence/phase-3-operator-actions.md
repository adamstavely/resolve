# Phase 3 evidence — operator actions and the live inbox

Status: 2026-10-12. Built and tested against the development mock fleet. The mock implements the gap-fixed action
and change-feed contracts (`packages/contracts/src/operations.ts`); the Quackback fork does not provide them yet.

## What exists

- **Recorded actions** (`apps/api/lib/operations.ts`, migration 0004):
  - Every action is stored as an `operations` row before dispatch, and each state change is appended to `audit_events`.
  - The audit holds the human, the app, the target, the tenant record id and a redacted summary. Message text is never stored.
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
| Audit correlation to the human and the tenant record | `tests/browser/inbox.spec.ts` › a reply is sent as the human…: the tenant message names Sam, and the `pending` and `succeeded` audit rows carry the tenant record id with no message text. `tests/database/operations.db.test.ts` |
| Uncertain outcomes visible | inbox.spec › a lost response is shown as not confirmed… and › check result reconciles…: a fault-injected lost response shows "Not confirmed" |
| No automatic retry of non-idempotent actions | The same tests show the tenant has exactly one copy after the lost response and still one after a user retry. `toApi` never offers an automatic retry |
| Tenant permissions rechecked independently | inbox.spec › the tenant rechecks permissions…: Bo is an agent in Resolve but an observer in HR, and HR refuses his reply (`denied`, `FORBIDDEN`) |
| Confirmation for destructive work | Closing a conversation and resolving a ticket both go through a confirmation dialog, which defaults to the safe choice and returns focus |
| Concurrent agents | inbox.spec › another agent's assignment appears live…: Ada's assignment updates Sam's open thread, and Sam's stale version is refused |
| Access changes end live access | inbox.spec › blocking a person closes their live stream |

## Not yet done

- **Attachments:** there's no upload from the composer yet; that needs `upload_file`, and downloads need QB-FILE-1. Threads show attachment names only.
- **Typing and presence:** plan 09 needs verified tenant semantics first, so the open stream doesn't fake presence.
- **Personal drafts:** drafts are kept in memory only, per plan 09. Durable drafts need an approved retention policy.
- **Load and freshness targets:** the two-second delivery target and the stream's DB/listener load are untested.
- **Unread count:** it covers loaded open conversations only. A tenant-side unread total would make it exact; that belongs in `get_support_dashboard` or a new aggregate.
