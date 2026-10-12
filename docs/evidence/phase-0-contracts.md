# Phase 0 evidence — contract specification and tool inventory

Status: 2026-10-12. Static source inventory and executable contract definitions. No live tenant, OAuth or
worker has been exercised, so these are specified contracts, not verified integrations.

Quackback pinned at `adamstavely/quackback@49ea2028773018064d99f37c8e41b7887004b9b2` (package 0.14.1).
That commit only adds plan documents on top of code baseline `562a6b1de`, which plans 10 and 11 reviewed.

## Where the contracts live

`packages/contracts/src` (Zod schemas plus pure decision functions, shared by API and console):

| Plan 01 contract | Module | Enforced by tests |
|---|---|---|
| 1 Registry read | `registry.ts` | Strict projection rejects DSN/secret/credential fields; unknown state → unavailable |
| 2 Human OAuth | `oauth.ts` | State bound to session, user and app; single use; expiry; identity checked against issuer/subject mapping, never email |
| 3 Tenant tools | `tenant-tools.ts` | Inventory, scopes, permissions, object policy, idempotency, gaps; argument/result schemas for existing tools |
| 4 Privileged jobs | `jobs.ts` | Allowlisted commands; strict parameters (no image/env/DSN override); digest-pinned images; stage machine |
| 5 Audit | `audit.ts` | Human vs system actor; redaction drops secret-named keys and free text |
| 6 Compatibility | `compatibility.ts` | Unknown protocol disables mutations; reasons are actionable |
| Capabilities | `capabilities.ts` | Every capability maps to tools/jobs; observer requests `read:chat` only |
| Outcomes | `outcomes.ts` | Timeout after send = uncertain; no automatic retry of non-idempotent sends |
| Aggregation | `fleet.ts` | Per-app provenance; unavailable metrics are never counted as zero |
| Broadcasts | `broadcasts.ts` | Everyone only; reviewed unique recipients; per-app key; changed payload under the same key = conflict |

Commands:
- `npm test`: contract invariants, in `tests/contracts/*.unit.test.ts`.
- `QUACKBACK_SRC=<fork checkout> npm run test:contract`: checks every tool's scope, base permission and argument list against the fork's handlers and its R-5 permission specs. It also fails when a "missing" tool appears or the `authenticated` audience tier changes, so the inventory is updated deliberately.

## Tool inventory (first-release workflows only)

| Tool | Status | Scope | Permission | Blocking gaps |
|---|---|---|---|---|
| list_conversations | needs change | read:chat | conversation.view | QB-CHAT-5 |
| get_conversation | needs change | read:chat | conversation.view | QB-CHAT-4, 5 |
| reply_to_conversation | needs change | write:chat | conversation.reply | QB-CHAT-4, 6 |
| set_conversation_status | **available** | write:chat | conversation.set_status | — |
| list_tickets | needs change | read:chat | ticket.view | QB-TICKET-1 |
| get_ticket | **available** | read:chat | ticket.view (+ assertTicketVisible) | — |
| reply_to_ticket / add_ticket_note | needs change | write:chat | ticket.reply / ticket.note | QB-CHAT-6 |
| upload_file | **available** | write:chat | any reply/note key | — |
| add_conversation_note, assign_conversation, mark_conversation_read | missing | write:chat | conversation.note / assign / view | QB-CHAT-1 (+6) |
| get_operation_result | missing | read:chat | author only | QB-CHAT-6 |
| subscribe_changes | missing | read:chat | per event | QB-CHAT-2, 3 |
| get_attachment | missing | read:chat | parent visibility | QB-FILE-1 |
| assign_ticket, set_ticket_status | missing | write:chat | ticket.assign / set_status | QB-TICKET-2 |
| get_support_dashboard, list_support_activity | missing | read:chat | analytics.view (dashboard) + conversation.view + ticket.view | QB-DASH-1, 2 |
| list/upsert/archive_announcement | missing | *proposed* read/write:announcement | announcement.view / manage | QB-ANN-1, 2 |

Capability readiness (snapshot test `readiness against the pinned fork`): only `fleet.view`, `connection.manage`,
`chat.status`, `audit.read` and the administration capabilities (which depend on worker jobs, not tenant tools) are not blocked by a tenant gap.
Every dashboard, inbox and broadcast capability needs Quackback fork work first.

## New findings (beyond plans 10 and 11)

- **Everyone audience (resolved).** The fork has `AUDIENCE_TIERS = ['authenticated', 'segments']`. Owner decision
  2026-10-12: Everyone is `authenticated`, so no new tier is needed (`EVERYONE_TENANT_AUDIENCE`).
- **QB-ANN-1, no announcement scope.** The OAuth/API-key scope vocabulary has no announcement domain. The
  service (`fork/announcements/announcements.service.ts`) is ready for MCP tools, but a new scope is needed so
  that `write:chat` or `write:settings` isn't overloaded.
- **QB-TICKET-1/2.** `list_tickets` has no cursor and drops `hasMore`. Ticket assign and status exist only as
  API-key REST routes (`routes/api/v1/tickets/$ticketId.{assign,status}.ts`), not under human OAuth.
- **Ticket direct-ID access is enforced.** The fork's R-5 gate (`fork/rbac/mcp-tool-permissions.ts`) applies
  `assertTicketVisible` to `get_ticket`, `reply_to_ticket` and `add_ticket_note`, even though `getTicket` itself takes no actor.
  Conversation direct-ID access remains upstream's (`// by-ID access stays upstream's, O-R7`), which is QB-CHAT-4.
- **QB-REG-1 / QB-PROTO-1.** The registry (`lib/server/workspaces/registry.ts`) is read only by fleet-internal code.
  No Resolve-facing projection or protocol/tool-version advertisement exists.

## Phase 0 exit criteria (plan 00)

| Criterion | State |
|---|---|
| Each feature mapped to a tool and permission | **Met in code.** `capabilityReadiness()` with the snapshot test |
| Exact Quackback commit/image and protocol versions recorded | Commit recorded; there is no image digest or protocol version yet (QB-PROTO-1) |
| No undocumented privileged shortcut | Contract-level: strict job API, no service-principal or API-key path. Still needs the threat model and network review |
| Identity mapping demonstrated without email linking | Not started. Needs the IdP (plan 05, Q2) and two live tenant hosts |
| Provisioner API ownership agreed | Owner decision. The contract proposal is in `jobs.ts` |
| Two tenant hosts, real edge proxy and IdP validated | Not started. Needs infrastructure inputs (plan 05, Q5) |

## Next work this unblocks

1. Open Quackback fork issues for each gap in `GAPS`, with owner, protocol version and acceptance test.
   P1 order: QB-CHAT-1/4/6, QB-TICKET-1/2, QB-DASH-1, QB-ANN-1/2, QB-REG-1, QB-PROTO-1, then the live-feed work (QB-CHAT-2/3).
2. Owner decisions recorded 2026-10-12 (plan 05): shared unread, Everyone = `authenticated`, admins hold
   administration, dashboard requires `analytics.view`, and a mock OIDC/SAML 2.0 IdP for development.
