# Unified SRE chat inbox — first release

## Confirmed outcome

SRE agents receive and handle chats from registered applications inside Resolve. They do not need to
open individual Quackback instances for the normal chat workflow. This expands the existing conversation
list/reply scope into an explicit first-release requirement, not a future enhancement.

“Forwarding” means securely delivering tenant conversation events and reading/writing the original
conversation through Quackback APIs. Quackback remains the source of truth for messages, participants,
assignment, unread state and attachments. Do not create a second conversation or relay messages as a bot.

## End-to-end flow

1. An employee starts or replies to a chat in an application's existing Quackback integration.
2. Quackback commits the message and its conversation event. Resolve receives a tenant-scoped change
   notification, then fetches the authorized conversation/message data through the tenant API.
3. Resolve updates the unified queue and unread indicator without navigation or manual refresh.
4. The SRE opens the conversation in Resolve, sees its originating application and complete authorized
   history, and claims/assigns it according to the tenant's permissions and support-team rules.
5. Replies and attachments are sent through Resolve's backend using the SRE's per-app human grant.
   Quackback records that SRE as author and delivers the message through its existing customer channel.
6. Incoming messages and state changes appear in the open thread. Resolve supports internal notes,
   assignment, status changes and the linked ticket without sending the agent to another instance.

Source verification is recorded in document 10. The current APIs are insufficient without the listed Quackback prerequisites; this section describes the required target contract.

## SRE interface

Unified queue with app/environment, customer, subject/preview, status, assignee/team, last activity and
unread state. Filters: all permitted apps, selected apps, assigned to me, unassigned and team. Retain the
selected conversation while new messages reorder the queue; do not steal keyboard focus.

Thread panel shows an unmistakable app/environment label, history, attachments, internal notes and
linked-ticket context. Composer distinguishes public reply from internal note, preserves drafts per
(app, conversation, agent), and uses explicit Send. Drafts contain customer data: default to memory;
any durable draft storage requires approved retention and access controls.

Show queued/sending/confirmed/failed/uncertain message states. Do not show an optimistic message as
confirmed before tenant acknowledgement. Show another agent's assignment or reply promptly; version-check
claim/assignment where supported to avoid silent competing ownership. Normal operation includes message
history pagination, attachment download/upload, reply, note, assignment, mark-read and close/reopen.
Typing and presence are desirable but require verified tenant semantics; they are not faked by keeping
an integration stream open. Specific behavior is settled in the phase-0 contract inventory.

## API and event contracts to verify/build in Quackback

- List accessible conversations with stable pagination and update ordering; fetch conversation/messages
  by ID with object authorization; fetch linked ticket context under its own permission checks.
- Send reply/note with a client operation ID and payload hash; get operation result for ambiguous sends.
  Existing non-idempotent send endpoints need a narrow fork adapter before automatic retries are allowed.
- Unread contract requires a decision: Quackback currently uses a shared agent-side watermark, not per-agent receipts. Proposed v1 preserves that shared meaning; personal unread needs additional design (QB-CHAT-7).
- Assign/claim, set status and preserve existing tier/SLA rules. Resolve must not bypass tenant assignment
  invariants or reimplement them in its own database.
- Attachment upload/download with tenant authorization, size/type policy, scanning and expiry behavior.
  No public object-store URL or tenant credential is exposed to the browser.
- Resumable conversation change feed: app-scoped event ID/cursor, conversation ID, change type and
  authorization-safe payload. Document delete/redaction, membership/permission changes and message edits.

Phase 0 inventories current REST/MCP/realtime implementations and writes exact schemas, permissions and
missing endpoints. Do not assume `/api/chat/stream` is a fleet-agent subscription: verify its session,
conversation scope, presence side effects and token lifecycle first.

## Proposed live delivery architecture

Resolve Node backend maintains authorized subscriptions for connected SREs and multiplexes updates to
its Angular UI through a same-origin authenticated stream. Tenant events are hints to fetch current
state, never authorization to reveal a conversation. Prefer content-free invalidation events and filter
at the tenant read. Never send unauthorized conversation identifiers/content to an SRE browser.

If existing tenant streams cannot resume reliably, add a narrow authenticated fork change-feed contract
with a durable cursor/outbox in Quackback. This is a first-release prerequisite, not permission to replace
live delivery with an undocumented polling loop. A bounded polling fallback may support recovery, with
visible degraded state and an explicit freshness target established by load testing.

Proposed target: new messages normally visible within two seconds after commit; validate fleet size,
latency and capacity before promising it. Reconnect supplies last acknowledged cursor; expired cursor
triggers an authorized resync with deduplication by (workspace, message/event ID). Subscribe/snapshot
ordering must close the read-before-subscribe gap. Preserve per-conversation order and handle duplicate,
out-of-order, edited and deleted messages. A lost event cannot permanently hide a chat.

The earlier blanket “no background polling/waking” rule applies to passive dashboards, not an SRE who
opens live inbox monitoring. Active chat monitoring explicitly keeps selected tenant connections warm.
Show monitored versus disconnected/dormant apps. Never label an app “live” while ignoring its messages.
Bound per-agent/app subscriptions, release them on logout/idle/denial, and measure pooled DB/listener load.
Avoid a fleet-wide service principal as a shortcut around human permission checks.

## Security and recovery

Tokens stay server-side, per user/app. Recheck denied users and current permissions on stream connection,
renewal and data fetch; close/revoke subscriptions on access changes. Caches are partitioned by tenant and
permission context. Expired grants prompt reconnect and preserve the draft; other apps remain usable.

Every send records Resolve intent and tenant human-attributed result. Timeout after send is uncertain;
reconcile the same operation ID before retrying. Do not infer success/failure from message text equality.
Use a separate idempotency identity for a deliberately new message. Failed attachment uploads cannot
silently produce an empty or duplicate reply. No global cross-tenant transaction is assumed.

## Acceptance gates

- Employee in app A chats; authorized SRE receives and replies entirely in Resolve; employee sees reply
  once and tenant audit/history names the SRE. Repeat simultaneously for app B without data crossover.
- Observer/unrelated team cannot view or reply by guessing conversation/message/attachment IDs.
- Two agents claiming/replying see actual tenant state; no duplicated optimistic messages or silent
  assignment overwrite. Existing tier and SLA behavior is preserved.
- Disconnect, expire token, restart subscription worker, drop/reorder events and overflow cursor retention:
  recover authorized history without lost/duplicated messages, with honest degraded indicators.
- Deny an SRE or remove app access while the thread is open: no further data/replies are allowed.
- Send commits before timeout: reconcile once without duplicate employee-visible message.
- Keyboard and screen-reader users can browse, read, compose, attach, send and recover errors; incoming
  updates do not steal focus or announce entire histories. WCAG 2.2 AA applies to the complete flow.

First release cannot be called complete if “Open in Quackback” is required to perform routine chat work.
Deep links may remain optional diagnostics, not the primary agent workflow.
