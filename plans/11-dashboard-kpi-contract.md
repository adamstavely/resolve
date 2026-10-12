# First-pass dashboard KPIs — API verification and proposed definitions

Owner accepted these cards as the first pass. Source review: Quackback main
562a6b1de0b4d847d846e047a1818666e2030626, 2026-10-12. Static verification only;
no live endpoint, database fixture or performance test was run.

## Conclusion

The tenant database/domain layer contains the necessary underlying data. Existing external APIs do not
provide a complete, accurate, permission-scoped KPI contract. Add a narrow human-OAuth aggregate tool
in Quackback; Resolve must not connect to tenant databases or count a capped list as a fleet total.
Existing internal dashboard functions are reusable implementation references, not stable external APIs.

## Cards and definitions

### Open tickets

Proposed: count visible, non-deleted, non-test ticket records whose status category is open. Count each
ticket once, including a linked customer ticket. Use a ticket drill-down with exactly that predicate.
If the desired card is unified open support work (chats plus tickets), give it a different name and use
the upstream pair-deduplicated inbox convention; never sum raw ticket and conversation totals.

Evidence: mcp/tools/tickets.ts exposes statusCategory filtering, but list_tickets has limit <=100 and
explicitly drops hasMore with no cursor input. REST ticket DTO contains category/assignee fields, but
REST authenticates API keys rather than the SRE's human OAuth grant. No verified external total endpoint.
Internal domains/inbox/inbox.query.ts:577-605 counts standalone open ticket types and excludes linked
customer tickets; countInboxScopes adds the conversation half. That is not a raw open-ticket total.

### Unassigned tickets

Proposed: subset of Open tickets with no individual assignee; a team-assigned ticket without an individual
still counts. Optionally expose a separate no-team breakdown, not a competing definition of unassigned.
Respect the caller's visibility; this does not grant access to a global unassigned queue.

Evidence: REST/MCP ticket DTOs include assigneePrincipalId and assigneeTeamId. Internal inbox unassigned
badge counts conversations with assignedAgentPrincipalId NULL (inbox.query.ts:538-550), not tickets.
Do not directly label that existing badge “Unassigned tickets.” Requires a new aggregate query.

### Awaiting response

Recommended label: **Customers awaiting response**. Reuse the upstream conversation waiting predicate:
waitingSince IS NOT NULL, status != closed, non-test visitor and conversationFilter(actor).
A linked ticket/conversation contributes once through the conversation. This includes repeated customer
follow-ups, not only cases where firstResponseAt is null. Do not use awaiting_requester: that stage means
waiting for the customer, not waiting for an SRE. Standalone tickets need a separately verified pending-
response predicate before inclusion; do not invent one from last updated time.

Evidence: domains/admin-overview/admin-overview.query.ts:360-370 implements this count. It is accessed
by functions/admin-overview.ts via a session-based TanStack server function, not a supported MCP/REST
aggregate. Expose the predicate through the proposed OAuth tool and match its drill-down.

### SLA breached / approaching deadline

Use two values/cards for **current actionable SLA risk**, not historical breach attainment. Proposed
unit: unique visible support items with an outstanding breached clock, and unique items with an active
clock approaching its deadline but none already breached. Deduplicate linked ticket/conversation pairs;
retain per-clock breakdown and earliest deadline in drill-down. Initial warning horizon proposed 30 minutes,
configurable and returned in the response; owner approval pending.

Conversation clocks cover first response, next response and time to close; ticket SLA has time to resolve.
Use authoritative SLA stamps, settlement/pause state and business-calendar-computed deadlines. Do not
recompute business hours in Resolve. Exclude settled clocks; stopped clocks are not newly approaching or
newly overdue. Specify previously breached-then-paused behavior consistently with tenant semantics and test
it before finalizing the aggregate. Compare deadlines at one tenant snapshot time, accounting for sweep lag.

Evidence: domains/sla/sla-reporting.ts reports historical met/breached ledger events and is not a current
risk count. domains/sla/ticket-sla.sweep.ts checks slaApplied.timeToResolveDueAt, pausedAt, resolvedAt and
resolutionBreachedAt. packages/db/src/schema/tickets.ts:151-153 stores the SLA stamp. The external
routes/api/v1/tickets/-serialize.ts exposes dueAt, not this SLA stamp; MCP detail's dueAt likewise cannot
support SLA inference. No external SLA risk aggregate was found in the inspected route/tool inventory.

### Recent activity

Treat as a chronological feed, not an ambiguous number. Proposed initial window 24 hours, with a bounded
page and cursor: customer messages, agent replies/notes, assignment and status changes. Every entry names
app, item, actor when available, action and timestamp. Permissions filter both entries and their content.
For a summary card, define its number as events within that window, not tickets updated.

Evidence: conversation lists expose lastMessageAt and ticket lists updatedAt; those do not reconstruct
an event history. Public post activity exists but is not ticket/chat activity. The current inbox stream
is live-only without durable inbox replay (document 10). Add an authorized activity list over persisted
message/activity sources; document which events lack historical coverage. Do not claim a complete historical
feed from events captured only after Resolve starts monitoring.

## Proposed external contract (not implemented)

`get_support_dashboard` with bounded filters (team, assignee, ticket type) and warningHorizonMinutes.
Derive actor from human OAuth, never an actor ID supplied by Resolve. Tenant determines one asOf time and
reads a consistent snapshot. Return schemaVersion, asOf, appliedFilters, counts, clock breakdown,
warningHorizonMinutes, supportedMetrics and matching drill-down descriptors.
A companion `list_support_activity` returns authorized cursor-paged activity and coverage metadata.

Require appropriate read:chat scope and per-entity permissions/object predicates; if analytics.view is
required, grant it deliberately rather than allowing aggregates to bypass ticket/conversation visibility.
A metric without permission or implementation is unavailable, never zero. Resolve aggregates only compatible
definitions, reports app coverage/last refresh and partial failures, and distinguishes no data from no access.
Cache per user/app/filter/permission version with bounded freshness. SLA timers need periodic refresh even
when no message event arrives. Passive dormant apps may show stale/unavailable with an explicit refresh;
active chat monitoring follows document 09. Do not promise a current fleet total while omitting dormant apps.

## Acceptance before delivery

More than 100 tickets; linked/unlinked records; open versus closed; individual/team/unassigned cases;
first and subsequent customer replies; awaiting requester; deleted/test items; paused/resumed/reapplied SLA;
multiple breached clocks on one pair; business-calendar boundaries; delayed breach sweep; permission
revocation and direct drill-down parity; partial fleet failures; event pagination and equal timestamps.
Counts and drill-down must use the same domain predicate and snapshot semantics, without double-counting.
Run real DB fixtures and performance tests before marking the APIs ready.
