# Quackback chat API and event verification

Reviewed 2026-10-12 against fetched origin/main
`562a6b1de0b4d847d846e047a1818666e2030626` in adamstavely/quackback.
Static source review, not a live OAuth, browser, database or load certification. No implementation changed.
Paths below are relative to that Quackback checkout. Prior plan claims are not treated as implementation.

## Verdict

Quackback has reusable conversation domain services and APIs, but the current external API/event surface
is not sufficient for the complete Resolve SRE inbox. Basic OAuth reads/replies/status work at the handler
contract level. Full live inbox, notes/assignment under human OAuth, rich thread DTOs, safe retry and
consistent row authorization require narrow Quackback fork additions before Resolve UI integration.

## Verified available

- `mcp/tools/conversations.ts`: list_conversations (status, priority, agent, cursor), get_conversation
  (30-message cursor pages, optional internal notes), reply_to_conversation and set_conversation_status.
  OAuth callers use their principal via agentFromMcpAuth/mcpAgentActor; scope is read:chat/write:chat.
- `mcp/tools/files.ts`: upload_file accepts base64, capped at 5 MiB decoded. Replies accept up to ten
  uploaded file IDs. This is an upload building block, not the complete attachment experience.
- `routes/api/v1/conversations/`: REST list/detail/messages, reply, note, assign, priority, read and status
  routes exist. Domain behavior can be reused; these routes authenticate API keys.
- `routes/api/chat/stream.ts`: SSE has inbox, presence, conversation and ticket scopes. Conversation
  message reconnect supports Last-Event-ID and subscribe-before-backfill buffering/deduplication.
  Inbox and ticket streams do not have equivalent replay.

## Gaps and required work

### QB-CHAT-1 — Human OAuth does not cover the complete action surface (P1)

REST uses withApiKeyAuth / verifyApiKey (`domains/api/auth.ts`), not the MCP OAuth token verifier.
MCP conversations exposes no general add-note, assignment or mark-read tool. Sending the human MCP JWT
as REST Bearer therefore does not supply a working authenticated route. A shared API key changes the
actor and is not an acceptable substitute for per-human attribution and row access.

Add versioned OAuth-accessible tools/adapters for the missing actions using existing domain services,
resolved permissions and human principal. Inventory status/assignment concurrency and tier prerequisites.
Acceptance: the same SRE grant performs every routine action and tenant records identify that SRE;
Observer, denied and unauthorized actors are refused independently of Resolve's UI.

### QB-CHAT-2 — Current stream is not a ready-made fleet OAuth feed (P1)

`routes/api/chat/stream.ts:63-90` resolves a dedicated signed stream token or Better Auth session,
not an MCP OAuth JWT. Inbox subscription checks legacy team membership (`:158-164`) and subscribes to
conversation:inbox. Live frames are forwarded without per-frame object filtering (`:324-338`).
`realtime/conversation-channels.ts` publishes conversation DTOs/events on that channel.
It is not a safe assumption that team-filtered list visibility applies to those frames.

Build a human-OAuth-authorized change feed or mint a narrowly scoped subscription credential from that
authority. Validate permissions/object visibility and denial continuously, not just at connect. Prefer
content-free authorized invalidations followed by an authorized read. Do not expose the broad existing
channel to Resolve agents merely by accepting their OAuth token.

### QB-CHAT-3 — No durable inbox catch-up; presence has side effects (P1)

Only a conversation message thread gets backfill; ticket scope explicitly documents no backfill at
stream.ts:210-213. Inbox events have no general retained sequence/cursor. A reconnect can miss a new
conversation, assignment/status change or other non-message update. Thread message IDs are not a global
inbox cursor. The heartbeat refreshes presence, not permissions (`:444-452`).
Inbox streams mark agents present and disconnect can requeue unanswered conversations (`:287-300`).
Opening Resolve monitoring would therefore affect routing, not just display data.

Specify resumable event cursor/outbox plus snapshot reconciliation (including edits/deletes), and separate
monitoring from intentional agent availability. Prove crash/reconnect, revoked access, duplicate/out-of-order
events and missed new conversations. Document DB/listener capacity and explicit live-monitoring wake-up.

### QB-CHAT-4 — List and direct-object authorization differ (P1)

`policy/conversations.ts` filters human lists to assigned agent/team unless view_all; services bypass team
membership. `policy/conversation.ts:25-29` permits direct reads with conversation.view alone. Thus a person
can be absent from a queue yet read a known ID. That conflicts with plan 09's direct-ID negative tests.

Align the Resolve-facing contract: enforce the agreed object policy on detail, messages, reply/note,
attachments and subscriptions. Do not claim upstream teams already provide strict isolation. If broader
read access is intentional, make it an explicit product/security decision and change the tests accordingly.

### QB-CHAT-5 — Thread DTOs omit data Resolve needs (P1 for complete chat)

MCP get_conversation maps messages to id/senderType/isInternal/authorName/content/createdAt
(`mcp/tools/conversations.ts:138-146`). REST serializeMessage also omits attachments and richer content
(`routes/api/v1/conversations/-serialize.ts`). Conversation response omits team/unread/linked-ticket
context. An attachment may be sent using fileIds but cannot be assumed discoverable/renderable from
these message responses. List tools also lack explicit team/unassigned filtering in their schema.

Add a stable authorized thread/queue DTO with attachment metadata and protected download contract,
rich content/card representation, author principal, edited/deleted state, team and ticket references,
and agreed unread data. Verify download/storage authorization separately; upload support is not proof
of secure downloads. Preserve upstream rendering semantics without copying its React UI.

### QB-CHAT-6 — Reply contract has no idempotent send identity (P1)

MCP reply schema accepts conversationId/content/fileIds; REST reply accepts content/attachments. Neither
exposes a client operation key or result lookup. A lost reply response cannot safely be retried as a
fresh send. Comparing text or relying on optimistic UI does not establish exactly-once visibility.

Add tenant-owned operation key + payload hash, durable message/result linkage and an authorized lookup.
Commit message and operation result atomically; preserve existing post-commit delivery recovery semantics.
Test response loss and concurrent same-key requests. Until then, surface uncertainty without auto-retry.

### QB-CHAT-7 — Unread is shared agent-side state, not per-SRE state (P2)

`conversation.service.ts:1967-1978` markConversationRead updates conversation.agentLastReadAt or
visitorLastReadAt. REST /read explicitly describes a team-visible mutation. There is no per-agent read
marker established by these paths; the previous plan's “real-agent unread receipts” assumption is incorrect.

Proposed v1: preserve Quackback's shared support-team unread semantics and label them accurately.
If personal unread is required, add a separate per-principal marker design and reconcile it with shared
state rather than storing a misleading local Resolve-only count. Owner decision remains pending.

## Integration work order

1. Agree row-access and shared/personal unread semantics; inventory exact schemas and required permissions.
2. Implement human OAuth missing actions and complete thread/attachment DTOs in Quackback with tests.
3. Implement tenant idempotent-send/result contract and durable event/reconnect contract.
4. Prove two-tenant, two-agent operation end-to-end, including routing presence and denial behavior.
5. Build Resolve's API client and Angular chat interface against those contracts; run accessibility and load
   gates before calling the first release complete.

No new service-principal impersonation, session-cookie scraping or direct tenant DB reads from Resolve.
Existing upstream domains remain the implementation source; adapters are explicit fork dependencies
with semantic contract tests on every upstream upgrade.
