import { z } from 'zod';
import { appKeySchema, isoDateTimeSchema } from './common';
import { appResultSchema, type FleetMetric } from './fleet';
import { toolResults } from './tenant-tools';

/*
 * Phase 2 fleet read (plan 00): target tenant tool versions and Resolve's read API.
 *
 * TARGET_TOOL_VERSIONS are the gap-fixed versions Resolve requires. The fork does not provide them yet
 * (QB-TICKET-1, QB-CHAT-4/5, QB-DASH-1/2, QB-PROTO-1); the development mock tenants implement them.
 * A tenant that does not advertise these versions is reported as incompatible, never guessed at (contract 6).
 */
export const TENANT_PROTOCOL_PATH = '/api/resolve/protocol';
export const TARGET_PROTOCOL = 1;
export const TARGET_TOOL_VERSIONS = {
 list_tickets: 2,          // + cursor / nextCursor / hasMore (QB-TICKET-1)
 get_ticket: 1,
 list_conversations: 1,
 get_conversation: 2,      // detail visibility = list visibility (QB-CHAT-4); attachments, team, links (QB-CHAT-5)
 get_support_dashboard: 1, // QB-DASH-1
 list_support_activity: 1, // QB-DASH-2
} as const;

const ts = isoDateTimeSchema;
const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const statusCategory = z.enum(['open', 'pending', 'closed']);

// ── Target tool wire schemas ──

export const targetToolArgs = {
 list_tickets: z.strictObject({
  statusCategory: statusCategory.optional(), assignee: z.enum(['me', 'unassigned']).optional(),
  sort: z.enum(['recent', 'oldest', 'priority']).optional(), cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).optional(),
 }),
 get_ticket: z.strictObject({ ticketId: z.string().min(1).max(200), cursor: z.string().max(500).optional() }),
 list_conversations: z.strictObject({ status: z.enum(['open', 'snoozed', 'closed']).optional(), cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).optional() }),
 get_conversation: z.strictObject({ conversationId: z.string().min(1).max(200), cursor: z.string().max(500).optional() }),
 get_support_dashboard: z.strictObject({ warningHorizonMinutes: z.number().int().min(5).max(1440).optional() }),
 list_support_activity: z.strictObject({ cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(50).optional() }),
};

const ticketSummary = toolResults.list_tickets.shape.tickets.element.extend({ assigneeName: z.string().nullable(), teamName: z.string().nullable() });
const attachment = z.object({ id: z.string(), name: z.string(), contentType: z.string(), size: z.number().int().nonnegative() });
const threadMessage = z.object({
 id: z.string(), senderType: z.enum(['visitor', 'agent', 'system']), isInternal: z.boolean(), authorName: z.string().nullable(),
 content: z.string(), createdAt: ts, attachments: z.array(attachment),
});

const tenantMetric = z.discriminatedUnion('status', [
 z.object({ status: z.literal('available'), value: z.number().int().nonnegative() }),
 z.object({ status: z.literal('unavailable'), reason: z.enum(['not_permitted', 'not_implemented']) }),
]);
export const KPI_METRICS = ['openTickets', 'unassignedTickets', 'awaitingResponse', 'slaBreached', 'slaApproaching', 'recentActivity'] as const;
export type KpiMetric = (typeof KPI_METRICS)[number];

export const ACTIVITY_KINDS = ['customer_message', 'agent_reply', 'internal_note', 'assignment', 'status_change', 'ticket_created'] as const;
const activityEntry = z.object({
 id: z.string(), at: ts, kind: z.enum(ACTIVITY_KINDS), itemType: z.enum(['ticket', 'conversation']),
 itemId: z.string(), title: z.string(), actorName: z.string().nullable(),
});

export const targetToolResults = {
 list_tickets: z.object({ tickets: z.array(ticketSummary), nextCursor: z.string().nullable(), hasMore: z.boolean() }),
 get_ticket: z.object({
  ticket: toolResults.get_ticket.shape.ticket.extend({ assigneeName: z.string().nullable(), teamName: z.string().nullable(), slaDueAt: ts.nullable(), slaBreachedAt: ts.nullable() }),
  messages: z.array(threadMessage), hasMore: z.boolean(), nextCursor: z.string().nullable(),
 }),
 list_conversations: z.object({
  conversations: z.array(toolResults.list_conversations.shape.conversations.element.extend({
   assigneeName: z.string().nullable(), teamName: z.string().nullable(), waitingSince: ts.nullable(), visitorName: z.string().nullable(),
  })),
  nextCursor: z.string().nullable(), hasMore: z.boolean(),
 }),
 get_conversation: z.object({
  conversation: toolResults.get_conversation.shape.conversation.extend({
   assigneeName: z.string().nullable(), teamName: z.string().nullable(), visitorName: z.string().nullable(), waitingSince: ts.nullable(), linkedTicketId: z.string().nullable(),
  }),
  messages: z.array(threadMessage), hasMore: z.boolean(), nextCursor: z.string().nullable(),
 }),
 get_support_dashboard: z.object({
  schemaVersion: z.literal(1), asOf: ts, warningHorizonMinutes: z.number().int(),
  metrics: z.object(Object.fromEntries(KPI_METRICS.map(m => [m, tenantMetric])) as Record<KpiMetric, typeof tenantMetric>),
 }),
 list_support_activity: z.object({ entries: z.array(activityEntry), nextCursor: z.string().nullable(), coverageSince: ts }),
};
export type TargetTool = keyof typeof targetToolResults;
export type TicketSummary = z.infer<typeof ticketSummary>;
export type ThreadMessage = z.infer<typeof threadMessage>;
export type ActivityEntry = z.infer<typeof activityEntry>;

// ── Resolve read API ──

/** Fleet responses: one result per requested app, each ok (with data) or unavailable (with a reason). */
export const fleetTicketsResponseSchema = z.strictObject({ apps: z.array(appResultSchema(targetToolResults.list_tickets)) });
export const fleetConversationsResponseSchema = z.strictObject({ apps: z.array(appResultSchema(targetToolResults.list_conversations)) });
export const ticketDetailResponseSchema = z.strictObject({ appKey: appKeySchema, detail: targetToolResults.get_ticket });
export const conversationDetailResponseSchema = z.strictObject({ appKey: appKeySchema, detail: targetToolResults.get_conversation });

const fleetMetric = z.strictObject({
 value: z.number().int().nonnegative().nullable(), included: z.array(z.string()),
 missing: z.array(z.strictObject({ appKey: z.string(), reason: z.string() })), complete: z.boolean(),
}) satisfies z.ZodType<FleetMetric>;

export const dashboardResponseSchema = z.strictObject({
 apps: z.array(appResultSchema(targetToolResults.get_support_dashboard)),
 totals: z.strictObject(Object.fromEntries(KPI_METRICS.map(m => [m, fleetMetric])) as Record<KpiMetric, typeof fleetMetric>),
 /** Latest entries from each app, merged by time for display. Not a globally paginated feed. */
 activity: z.array(activityEntry.extend({ appKey: appKeySchema })),
 activityApps: z.array(appResultSchema(z.strictObject({ coverageSince: ts, hasMore: z.boolean() }))),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
