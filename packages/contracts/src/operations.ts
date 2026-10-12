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
 upload_file: 2,            // bound to uploader + target, type policy, synchronous scan, expiry, upload key (QB-FILE-2)
 get_attachment: 1,         // authorized download through the named parent (QB-FILE-1)
 signal_activity: 1,        // explicit viewing/typing signals (QB-CHAT-8)
 get_conversation_activity: 1, // who is viewing/typing, customer online (QB-CHAT-8)
 get_availability: 1,       // explicit agent availability, separate from monitoring (QB-CHAT-3)
 set_availability: 1,
} as const;
export type ActionTool = keyof typeof ACTION_TOOL_VERSIONS;

const content = z.string().trim().min(1).max(4000);
const key = uuidSchema;
const version = z.number().int().nonnegative();

/**
 * Attachment policy (plan 09). Resolve checks it before upload and the tenant enforces it again. Files are
 * always downloaded as attachments (never rendered inline), so the type list is about what support needs.
 */
export const ATTACHMENT_POLICY = {
 maxBytes: 5 * 1024 * 1024,
 maxPerMessage: 10,
 types: {
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp'],
  'application/pdf': ['pdf'], 'text/plain': ['txt', 'log'], 'text/csv': ['csv'], 'application/json': ['json'], 'application/zip': ['zip'],
 } as Record<string, readonly string[]>,
} as const;
export const fileIdSchema = z.string().min(1).max(200);
const fileIds = z.array(fileIdSchema).max(ATTACHMENT_POLICY.maxPerMessage);
/** A message needs text, attachments, or both. */
const hasBody = (m: { content: string; fileIds?: string[] }) => m.content.length > 0 || (m.fileIds?.length ?? 0) > 0;
const messageBody = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...shape, content: z.string().trim().max(4000), fileIds: fileIds.optional() })
 .refine(m => hasBody(m as { content: string; fileIds?: string[] }), { message: 'Write a message or attach a file', path: ['content'] });
export const ACTIVITY_SIGNALS = ['viewing', 'typing', 'stopped'] as const;
export const AVAILABILITY = ['available', 'away'] as const;

export const actionToolArgs = {
 reply_to_conversation: messageBody({ conversationId: z.string(), operationKey: key }),
 add_conversation_note: messageBody({ conversationId: z.string(), operationKey: key }),
 assign_conversation: z.strictObject({ conversationId: z.string(), assignee: z.enum(['me', 'unassigned']), expectedVersion: version }),
 set_conversation_status: z.strictObject({ conversationId: z.string(), status: z.enum(['open', 'snoozed', 'closed']), expectedVersion: version }),
 mark_conversation_read: z.strictObject({ conversationId: z.string() }),
 reply_to_ticket: messageBody({ ticketId: z.string(), operationKey: key }),
 add_ticket_note: messageBody({ ticketId: z.string(), operationKey: key }),
 assign_ticket: z.strictObject({ ticketId: z.string(), assignee: z.enum(['me', 'unassigned']), expectedVersion: version }),
 set_ticket_status: z.strictObject({ ticketId: z.string(), statusCategory: z.enum(['open', 'pending', 'closed']), expectedVersion: version }),
 get_operation_result: z.strictObject({ operationKey: key }),
 list_changes: z.strictObject({ after: z.string().max(200).optional(), waitSeconds: z.number().int().min(0).max(25).optional() }),
 /** The upload key makes a retried upload return the same file instead of a second one. */
 upload_file: z.strictObject({ targetType: z.enum(['conversation', 'ticket']), targetId: z.string(), name: z.string().min(1).max(255), contentType: z.string().max(100), contentBase64: z.string(), uploadKey: key }),
 get_attachment: z.strictObject({ targetType: z.enum(['conversation', 'ticket']), targetId: z.string(), attachmentId: fileIdSchema }),
 signal_activity: z.strictObject({ conversationId: z.string(), activity: z.enum(ACTIVITY_SIGNALS) }),
 get_conversation_activity: z.strictObject({ conversationId: z.string() }),
 get_availability: z.strictObject({}),
 set_availability: z.strictObject({ status: z.enum(AVAILABILITY) }),
};

const messageResult = z.object({ messageId: z.string(), createdAt: isoDateTimeSchema, operationKey: key, replayed: z.boolean() });
const itemResult = z.object({ id: z.string(), version, status: z.string(), assigneeName: z.string().nullable() });
/** `activity` is ephemeral (viewing/typing/customer online): subscribers re-read activity only for an open thread. */
export const CHANGE_KINDS = ['message', 'assignment', 'status', 'read', 'created', 'activity'] as const;
const uploadedFile = z.object({ fileId: fileIdSchema, name: z.string(), contentType: z.string(), size: z.number().int().nonnegative(), expiresAt: isoDateTimeSchema });
export const conversationActivitySchema = z.object({
 visitor: z.object({ online: z.boolean(), typing: z.boolean() }),
 /** Other support staff in this conversation now; never the caller. */
 agents: z.array(z.object({ name: z.string(), activity: z.enum(['viewing', 'typing']) })),
 asOf: isoDateTimeSchema,
});
export type ConversationActivity = z.infer<typeof conversationActivitySchema>;
const availabilityResult = z.object({ status: z.enum(AVAILABILITY), changedAt: isoDateTimeSchema.nullable() });

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
 /** The tenant scans synchronously: an unsafe file is refused (FILE_REJECTED), never returned. */
 upload_file: uploadedFile,
 get_attachment: z.object({ id: z.string(), name: z.string(), contentType: z.string(), size: z.number().int().nonnegative(), contentBase64: z.string() }),
 signal_activity: z.object({ expiresAt: isoDateTimeSchema.nullable() }),
 get_conversation_activity: conversationActivitySchema,
 get_availability: availabilityResult,
 set_availability: availabilityResult,
};

// ── Resolve operation API ──

export const OPERATION_STATES = ['pending', 'succeeded', 'failed', 'uncertain', 'denied'] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/** Message actions carry a client-generated operation ID so a user-initiated retry is the same operation. */
export const messageActionSchema = z.strictObject({ kind: z.enum(['reply', 'note']), content: z.string().trim().max(4000), fileIds: fileIds.default([]), operationId: uuidSchema })
 .refine(m => m.content.length > 0 || m.fileIds.length > 0, { message: 'Write a message or attach a file', path: ['content'] });
export type UploadedFile = z.infer<typeof uploadedFile>;
export const uploadResponseSchema = z.strictObject({ file: uploadedFile.strict() });
export const activitySignalSchema = z.strictObject({ activity: z.enum(ACTIVITY_SIGNALS) });
export const activityResponseSchema = z.strictObject({ activity: conversationActivitySchema.strict() });
export const availabilityChangeSchema = z.strictObject({ status: z.enum(AVAILABILITY) });
/** GET/POST /api/availability: per-app results, never one fleet-wide claim. */
export const availabilityResponseSchema = z.strictObject({
 apps: z.array(z.strictObject({
  appKey: appKeySchema,
  status: z.enum([...AVAILABILITY, 'unknown']),
  /** Why the status is unknown or the change did not apply. */
  problem: z.enum(['not_connected', 'reconnect_required', 'unsupported', 'unavailable', 'dormant', 'failed']).nullable(),
 })),
});
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
