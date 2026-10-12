import { z } from 'zod';
import { appKeySchema, isoDateTimeSchema, uuidSchema } from './common';

/*
 * Phase 3 operator actions (plan 00, plan 09, plan 10). Target tenant action tools, the change feed, and
 * Resolve's operation API. As with reads, the fork does not provide these versions yet
 * (QB-CHAT-1/2/3/6, QB-TICKET-2); the mock tenants implement them. A tenant that does not advertise an
 * action's version has that action disabled, while its reads keep working (contract 6).
 */
export const ACTION_TOOL_VERSIONS = {
 reply_to_conversation: 2,  // + operationKey (QB-CHAT-6)
 add_conversation_note: 1,  // QB-CHAT-1
 assign_conversation: 1,    // version-checked (QB-CHAT-1)
 set_conversation_status: 2,// + expectedVersion
 mark_conversation_read: 1, // shared team watermark (QB-CHAT-7 decision)
 reply_to_ticket: 2,        // + operationKey
 add_ticket_note: 2,        // + operationKey
 assign_ticket: 1,          // QB-TICKET-2
 set_ticket_status: 1,      // QB-TICKET-2
 get_operation_result: 1,   // QB-CHAT-6
 list_changes: 1,           // QB-CHAT-2/3: content-free, resumable, per-viewer filtered
} as const;
export type ActionTool = keyof typeof ACTION_TOOL_VERSIONS;

const content = z.string().trim().min(1).max(4000);
const key = uuidSchema;
const version = z.number().int().nonnegative();

export const actionToolArgs = {
 reply_to_conversation: z.strictObject({ conversationId: z.string(), content, operationKey: key }),
 add_conversation_note: z.strictObject({ conversationId: z.string(), content, operationKey: key }),
 assign_conversation: z.strictObject({ conversationId: z.string(), assignee: z.enum(['me', 'unassigned']), expectedVersion: version }),
 set_conversation_status: z.strictObject({ conversationId: z.string(), status: z.enum(['open', 'snoozed', 'closed']), expectedVersion: version }),
 mark_conversation_read: z.strictObject({ conversationId: z.string() }),
 reply_to_ticket: z.strictObject({ ticketId: z.string(), content, operationKey: key }),
 add_ticket_note: z.strictObject({ ticketId: z.string(), content, operationKey: key }),
 assign_ticket: z.strictObject({ ticketId: z.string(), assignee: z.enum(['me', 'unassigned']), expectedVersion: version }),
 set_ticket_status: z.strictObject({ ticketId: z.string(), statusCategory: z.enum(['open', 'pending', 'closed']), expectedVersion: version }),
 get_operation_result: z.strictObject({ operationKey: key }),
 list_changes: z.strictObject({ after: z.string().max(200).optional(), waitSeconds: z.number().int().min(0).max(25).optional() }),
};

const messageResult = z.object({ messageId: z.string(), createdAt: isoDateTimeSchema, operationKey: key, replayed: z.boolean() });
const itemResult = z.object({ id: z.string(), version, status: z.string(), assigneeName: z.string().nullable() });
export const CHANGE_KINDS = ['message', 'assignment', 'status', 'read', 'created'] as const;

export const actionToolResults = {
 reply_to_conversation: messageResult,
 add_conversation_note: messageResult,
 assign_conversation: itemResult,
 set_conversation_status: itemResult,
 mark_conversation_read: z.object({ id: z.string(), readAt: isoDateTimeSchema }),
 reply_to_ticket: messageResult,
 add_ticket_note: messageResult,
 assign_ticket: itemResult,
 set_ticket_status: itemResult,
 get_operation_result: z.discriminatedUnion('state', [
  z.object({ state: z.literal('committed'), operationKey: key, payloadHash: z.string(), messageId: z.string(), createdAt: isoDateTimeSchema }),
  z.object({ state: z.literal('unknown'), operationKey: key }),
 ]),
 list_changes: z.object({
  /** Content-free invalidations: the subscriber re-reads the item with its own authority. */
  events: z.array(z.object({ cursor: z.string(), itemType: z.enum(['conversation', 'ticket']), itemId: z.string(), kind: z.enum(CHANGE_KINDS), at: isoDateTimeSchema })),
  cursor: z.string(),
  /** The `after` cursor is older than retention: re-read current state, then continue from `cursor`. */
  resync: z.boolean(),
 }),
};

// ── Resolve operation API ──

export const OPERATION_STATES = ['pending', 'succeeded', 'failed', 'uncertain', 'denied'] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/** Message actions carry a client-generated operation ID so a user-initiated retry is the same operation. */
export const messageActionSchema = z.strictObject({ kind: z.enum(['reply', 'note']), content, operationId: uuidSchema });
export const assignActionSchema = z.strictObject({ assignee: z.enum(['me', 'unassigned']), expectedVersion: version });
export const conversationStatusActionSchema = z.strictObject({ status: z.enum(['open', 'snoozed', 'closed']), expectedVersion: version });
export const ticketStatusActionSchema = z.strictObject({ statusCategory: z.enum(['open', 'pending', 'closed']), expectedVersion: version });

export const operationSchema = z.strictObject({
 id: uuidSchema,
 appKey: appKeySchema,
 operation: z.string(),
 targetType: z.enum(['conversation', 'ticket']),
 targetId: z.string(),
 state: z.enum(OPERATION_STATES),
 /** Machine-readable reason for failed/denied/uncertain states. */
 failureCode: z.string().nullable(),
 tenantRecordId: z.string().nullable(),
 createdAt: isoDateTimeSchema,
 completedAt: isoDateTimeSchema.nullable(),
 /** What the user may do next. Never an automatic retry for a non-idempotent action. */
 next: z.enum(['none', 'reconcile', 'retry_same_operation', 'refresh_and_retry']),
 /** For assignment/status changes: the item's new version and state. */
 result: z.strictObject({ version: version.nullable(), status: z.string().nullable(), assigneeName: z.string().nullable() }).nullable(),
});
export type Operation = z.infer<typeof operationSchema>;

/** Browser stream events (`GET /api/inbox/stream`, text/event-stream). */
export const inboxEventSchema = z.discriminatedUnion('type', [
 z.strictObject({ type: z.literal('change'), appKey: appKeySchema, itemType: z.enum(['conversation', 'ticket']), itemId: z.string(), kind: z.enum(CHANGE_KINDS), at: isoDateTimeSchema }),
 z.strictObject({ type: z.literal('resync'), appKey: appKeySchema }),
 z.strictObject({ type: z.literal('monitor'), apps: z.array(z.strictObject({ appKey: appKeySchema, state: z.enum(['connecting', 'live', 'not_connected', 'reconnect_required', 'dormant', 'unavailable', 'error']) })) }),
]);
export type InboxEvent = z.infer<typeof inboxEventSchema>;
