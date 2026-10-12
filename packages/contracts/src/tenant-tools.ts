import { z } from 'zod';
import { isoDateTimeSchema } from './common';

/*
 * Contract 3 (plan 01): tenant tool inventory, captured from the handlers, not from plan examples.
 * Source: adamstavely/quackback at QUACKBACK_BASELINE.commit, apps/web/src/lib/server/mcp/tools/*,
 * scopes from mcp/required-scope.ts, permissions from lib/server/fork/rbac/mcp-tool-permissions.ts.
 * Verify with: QUACKBACK_SRC=<checkout> npm run test:contract
 */
export const QUACKBACK_BASELINE = {
 repository: 'adamstavely/quackback',
 commit: '49ea2028773018064d99f37c8e41b7887004b9b2',
 /** Code baseline; 49ea202 adds plan documents only on top of it. */
 codeBaseline: '562a6b1de0b4d847d846e047a1818666e2030626',
 packageVersion: '0.14.1',
 inspectedAt: '2026-10-12',
} as const;

/** Scope vocabulary in the fork (lib/shared/api-key-scopes.ts). */
export const QUACKBACK_SCOPES = ['read:feedback', 'write:feedback', 'write:changelog', 'read:article', 'write:article', 'read:chat', 'write:chat', 'read:settings', 'write:settings'] as const;
export type QuackbackScope = (typeof QUACKBACK_SCOPES)[number];
/** Scopes Resolve needs that do not exist in the fork yet. */
export type ProposedScope = 'read:announcement' | 'write:announcement';

/** Permission keys Resolve relies on (lib/shared/permissions.ts). */
export type TenantPermission =
 | 'conversation.view' | 'conversation.view_all' | 'conversation.reply' | 'conversation.note' | 'conversation.assign' | 'conversation.set_status'
 | 'ticket.view' | 'ticket.view_all' | 'ticket.reply' | 'ticket.note' | 'ticket.assign' | 'ticket.set_status'
 | 'analytics.view' | 'announcement.view' | 'announcement.manage';

/**
 * Gaps that block a tool. QB-CHAT-* are from plan 10, QB-DASH-* from plan 11; the rest were found in
 * this inventory. Each one needs a Quackback fork issue with owner, version and acceptance test (plan 00).
 */
export const GAPS = {
 'QB-CHAT-1': 'Human OAuth lacks note, assign and mark-read actions for conversations',
 'QB-CHAT-2': 'No human-OAuth-authorized, per-frame-filtered change feed',
 'QB-CHAT-3': 'No durable inbox catch-up cursor; inbox stream presence changes routing',
 'QB-CHAT-4': 'Conversation direct-ID reads need only conversation.view, unlike team-filtered lists',
 'QB-CHAT-5': 'Thread DTOs omit attachments, rich content, author principal, edit/delete, team and ticket links',
 'QB-CHAT-6': 'Replies and notes have no operation key or result lookup for safe retry',
 'QB-TICKET-1': 'list_tickets caps at 100 and drops hasMore; no cursor argument',
 'QB-TICKET-2': 'No OAuth tool to assign a ticket or change its status (REST is API-key only)',
 'QB-DASH-1': 'No permission-scoped KPI aggregate (get_support_dashboard)',
 'QB-DASH-2': 'No authorized activity list (list_support_activity)',
 'QB-ANN-1': 'Announcement service exists, but no MCP tools or OAuth scope expose it',
 'QB-ANN-2': 'Announcement writes have no broadcast ID / idempotency key / payload-hash replay check',
 'QB-ID-1': 'Tenant OAuth tokens must assert the federated IdP issuer/subject (idp_iss, idp_sub) and principal_id so Resolve can prove account ownership',
 'QB-REG-1': 'No Resolve-facing, column-limited registry projection (registry is internal to the fleet)',
 'QB-PROTO-1': 'Tenants do not advertise supported protocol/tool versions',
 'QB-FILE-1': 'No authorized attachment download contract for Resolve',
 'QB-FILE-2': 'upload_file is not bound to an uploader and target, has no type policy, scan result, expiry or upload key',
 'QB-CHAT-8': 'No OAuth typing/viewing signals or activity read; agent presence is a side effect of the stream connection',
} as const;
export type GapId = keyof typeof GAPS;

export type ToolStatus = 'available' | 'requires_change' | 'missing';
/** How a caller may retry. `keyed`: a tenant-owned operation key makes replay safe. */
export type Idempotency = 'read' | 'idempotent' | 'not_idempotent' | 'keyed';

export interface ToolDescriptor {
 status: ToolStatus;
 scope: QuackbackScope | ProposedScope;
 permissions: readonly TenantPermission[];
 /** Object-level rule as enforced (or required) by the tenant. */
 objectPolicy: string;
 idempotency: Idempotency;
 gaps: readonly GapId[];
 source?: string;
}

const conv = 'apps/web/src/lib/server/mcp/tools/conversations.ts';
const tick = 'apps/web/src/lib/server/mcp/tools/tickets.ts';

export const TENANT_TOOLS = {
 // ── Available today (team role + scope + fork R-5 permission gate) ──
 list_conversations: { status: 'requires_change', scope: 'read:chat', permissions: ['conversation.view'], objectPolicy: 'Team-filtered list unless conversation.view_all', idempotency: 'read', gaps: ['QB-CHAT-5'], source: conv },
 get_conversation: { status: 'requires_change', scope: 'read:chat', permissions: ['conversation.view'], objectPolicy: 'Direct ID readable with conversation.view alone (must match list policy)', idempotency: 'read', gaps: ['QB-CHAT-4', 'QB-CHAT-5'], source: conv },
 reply_to_conversation: { status: 'requires_change', scope: 'write:chat', permissions: ['conversation.reply'], objectPolicy: 'Upstream service check; auto-assigns caller when unassigned', idempotency: 'not_idempotent', gaps: ['QB-CHAT-4', 'QB-CHAT-6'], source: conv },
 set_conversation_status: { status: 'available', scope: 'write:chat', permissions: ['conversation.set_status'], objectPolicy: 'Upstream service check', idempotency: 'idempotent', gaps: [], source: conv },
 list_tickets: { status: 'requires_change', scope: 'read:chat', permissions: ['ticket.view'], objectPolicy: 'Visibility-filtered list', idempotency: 'read', gaps: ['QB-TICKET-1'], source: tick },
 get_ticket: { status: 'available', scope: 'read:chat', permissions: ['ticket.view'], objectPolicy: 'assertTicketVisible on ticketId (fork gate)', idempotency: 'read', gaps: [], source: tick },
 reply_to_ticket: { status: 'requires_change', scope: 'write:chat', permissions: ['ticket.reply'], objectPolicy: 'assertTicketVisible on ticketId (fork gate)', idempotency: 'not_idempotent', gaps: ['QB-CHAT-6'], source: tick },
 add_ticket_note: { status: 'requires_change', scope: 'write:chat', permissions: ['ticket.note'], objectPolicy: 'assertTicketVisible on ticketId (fork gate)', idempotency: 'not_idempotent', gaps: ['QB-CHAT-6'], source: tick },
 upload_file: { status: 'requires_change', scope: 'write:chat', permissions: [], objectPolicy: 'Any of conversation/ticket reply or note; 5 MiB decoded; not bound to a target or uploader', idempotency: 'not_idempotent', gaps: ['QB-FILE-2'], source: 'apps/web/src/lib/server/mcp/tools/files.ts' },

 // ── Required by first-release workflows, not present in the fork ──
 add_conversation_note: { status: 'missing', scope: 'write:chat', permissions: ['conversation.note'], objectPolicy: 'Same policy as list/detail', idempotency: 'keyed', gaps: ['QB-CHAT-1', 'QB-CHAT-6'] },
 assign_conversation: { status: 'missing', scope: 'write:chat', permissions: ['conversation.assign'], objectPolicy: 'Version-checked; tier/team rules preserved', idempotency: 'idempotent', gaps: ['QB-CHAT-1'] },
 mark_conversation_read: { status: 'missing', scope: 'write:chat', permissions: ['conversation.view'], objectPolicy: 'Same policy as list/detail; updates the shared support-team watermark (owner decision 2026-10-12)', idempotency: 'idempotent', gaps: ['QB-CHAT-1'] },
 get_operation_result: { status: 'missing', scope: 'read:chat', permissions: [], objectPolicy: 'Only the operation author', idempotency: 'read', gaps: ['QB-CHAT-6'] },
 subscribe_changes: { status: 'missing', scope: 'read:chat', permissions: ['conversation.view'], objectPolicy: 'Per-event authorization; content-free invalidations', idempotency: 'read', gaps: ['QB-CHAT-2', 'QB-CHAT-3'] },
 get_attachment: { status: 'missing', scope: 'read:chat', permissions: ['conversation.view'], objectPolicy: 'Named parent conversation/ticket must contain it and be visible; internal-note files for staff only', idempotency: 'read', gaps: ['QB-FILE-1'] },
 signal_activity: { status: 'missing', scope: 'write:chat', permissions: ['conversation.view'], objectPolicy: 'Same policy as detail; typing only for reply authors, never for notes', idempotency: 'idempotent', gaps: ['QB-CHAT-8'] },
 get_conversation_activity: { status: 'missing', scope: 'read:chat', permissions: ['conversation.view'], objectPolicy: 'Same policy as detail', idempotency: 'read', gaps: ['QB-CHAT-8'] },
 get_availability: { status: 'missing', scope: 'read:chat', permissions: [], objectPolicy: 'The caller only', idempotency: 'read', gaps: ['QB-CHAT-3'] },
 set_availability: { status: 'missing', scope: 'write:chat', permissions: ['conversation.reply'], objectPolicy: 'The caller only; explicit, never implied by a stream connection', idempotency: 'idempotent', gaps: ['QB-CHAT-3'] },
 assign_ticket: { status: 'missing', scope: 'write:chat', permissions: ['ticket.assign'], objectPolicy: 'assertTicketVisible; version-checked', idempotency: 'idempotent', gaps: ['QB-TICKET-2'] },
 set_ticket_status: { status: 'missing', scope: 'write:chat', permissions: ['ticket.set_status'], objectPolicy: 'assertTicketVisible', idempotency: 'idempotent', gaps: ['QB-TICKET-2'] },
 get_support_dashboard: { status: 'missing', scope: 'read:chat', permissions: ['analytics.view', 'conversation.view', 'ticket.view'], objectPolicy: 'Counts use the same predicates as drill-down lists', idempotency: 'read', gaps: ['QB-DASH-1'] },
 list_support_activity: { status: 'missing', scope: 'read:chat', permissions: ['conversation.view', 'ticket.view'], objectPolicy: 'Entries and content filtered per caller', idempotency: 'read', gaps: ['QB-DASH-2'] },
 list_announcements: { status: 'missing', scope: 'read:announcement', permissions: ['announcement.view'], objectPolicy: 'Workspace announcements', idempotency: 'read', gaps: ['QB-ANN-1'] },
 upsert_announcement: { status: 'missing', scope: 'write:announcement', permissions: ['announcement.manage'], objectPolicy: "Fleet broadcasts use tier 'authenticated' (Everyone)", idempotency: 'keyed', gaps: ['QB-ANN-1', 'QB-ANN-2'] },
 get_announcement_by_key: { status: 'missing', scope: 'read:announcement', permissions: ['announcement.manage'], objectPolicy: 'Announcements this caller published', idempotency: 'read', gaps: ['QB-ANN-2'] },
 archive_announcement: { status: 'missing', scope: 'write:announcement', permissions: ['announcement.manage'], objectPolicy: 'Version-checked against local edits', idempotency: 'idempotent', gaps: ['QB-ANN-1'] },
} as const satisfies Record<string, ToolDescriptor>;
export type TenantToolName = keyof typeof TENANT_TOOLS;

// ── Wire schemas for available tools, transcribed from the handlers and DTO types (shared/conversation/types.ts,
//    domains/tickets/ticket.types.ts); a live contract run against a tenant must confirm them (plan 04). Results use non-strict objects:
//    additive tenant fields are allowed; removals and type changes fail parsing. ──

const conversationStatus = z.enum(['open', 'snoozed', 'closed']);
const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const ts = isoDateTimeSchema;

export const toolArgs = {
 list_conversations: z.strictObject({ status: conversationStatus.optional(), priority: priority.optional(), assignedAgentPrincipalId: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
 get_conversation: z.strictObject({ conversationId: z.string(), includeInternal: z.boolean().optional(), cursor: z.string().optional() }),
 reply_to_conversation: z.strictObject({ conversationId: z.string(), content: z.string().min(1).max(4000), fileIds: z.array(z.string()).max(10).optional() }),
 set_conversation_status: z.strictObject({ conversationId: z.string(), status: conversationStatus }),
 list_tickets: z.strictObject({ type: z.enum(['customer', 'back_office', 'tracker']).optional(), ticketTypeId: z.string().optional(), statusCategory: z.enum(['open', 'pending', 'closed']).optional(), stage: z.enum(['received', 'in_progress', 'awaiting_requester', 'resolved']).optional(), requesterPrincipalId: z.string().optional(), companyId: z.string().optional(), sort: z.enum(['recent', 'oldest', 'created', 'priority']).optional(), limit: z.number().int().min(1).max(100).optional() }),
 get_ticket: z.strictObject({ ticketId: z.string(), includeInternal: z.boolean().optional(), cursor: z.string().optional() }),
 reply_to_ticket: z.strictObject({ ticketId: z.string(), content: z.string().min(1).max(10000), fileIds: z.array(z.string()).max(10).optional() }),
 add_ticket_note: z.strictObject({ ticketId: z.string(), content: z.string().min(1).max(10000), fileIds: z.array(z.string()).max(10).optional() }),
 upload_file: z.strictObject({ name: z.string().min(1).max(255), contentBase64: z.string() }),
} satisfies Partial<Record<TenantToolName, z.ZodType>>;

const message = z.object({ id: z.string(), senderType: z.enum(['visitor', 'agent', 'system']), isInternal: z.boolean(), authorName: z.string().nullable(), content: z.string(), createdAt: ts });

export const toolResults = {
 list_conversations: z.object({
  conversations: z.array(z.object({ id: z.string(), status: conversationStatus, priority, channel: z.string(), subject: z.string().nullable(), lastMessageAt: ts, visitorPrincipalId: z.string(), assignedAgentPrincipalId: z.string().nullable() })),
  nextCursor: z.string().nullable(), hasMore: z.boolean(),
 }),
 get_conversation: z.object({
  conversation: z.object({ id: z.string(), status: conversationStatus, priority, channel: z.string(), subject: z.string().nullable(), visitorPrincipalId: z.string(), visitorEmail: z.string().nullable(), assignedAgentPrincipalId: z.string().nullable(), lastMessageAt: ts, resolvedAt: ts.nullable(), createdAt: ts }),
  messages: z.array(message), hasMore: z.boolean(), nextCursor: z.string().nullable(),
 }),
 reply_to_conversation: z.object({ id: z.string(), conversationId: z.string(), status: conversationStatus, createdAt: ts }),
 set_conversation_status: z.object({ id: z.string(), status: conversationStatus }),
 list_tickets: z.object({
  tickets: z.array(z.object({ id: z.string(), number: z.number().int(), reference: z.string(), type: z.enum(['customer', 'back_office', 'tracker']), title: z.string(), status: z.string(), statusCategory: z.enum(['open', 'pending', 'closed']), stage: z.string(), priority, requesterPrincipalId: z.string().nullable(), assigneePrincipalId: z.string().nullable(), assigneeTeamId: z.string().nullable(), updatedAt: ts })),
 }),
 get_ticket: z.object({
  ticket: z.object({ id: z.string(), number: z.number().int(), reference: z.string(), title: z.string(), status: z.object({ name: z.string(), category: z.enum(['open', 'pending', 'closed']) }), stage: z.string(), priority, assigneePrincipalId: z.string().nullable(), assigneeTeamId: z.string().nullable(), dueAt: ts.nullable(), createdAt: ts, updatedAt: ts }),
  messages: z.array(message), hasMore: z.boolean(), nextCursor: z.string().nullable(),
 }),
 reply_to_ticket: z.object({ id: z.string(), ticketId: z.string(), createdAt: ts }),
 add_ticket_note: z.object({ id: z.string(), ticketId: z.string(), createdAt: ts }),
 upload_file: z.object({ fileId: z.string(), name: z.string() }),
} satisfies { [K in keyof typeof toolArgs]: z.ZodType };
