import { z } from 'zod';
import { appKeySchema, isoDateTimeSchema, payloadHash, uuidSchema } from './common';

/*
 * Banner broadcasts (plan 08). Resolve publishes the banner's content; each application presents it with its own
 * banner widgets and styles. Everyone audience only; recipients are an explicit snapshot reviewed by
 * the author. One delivery per app per revision, keyed so retries and reconciliation stay idempotent.
 * Field limits follow the fork's announcementInputSchema (lib/shared/fork/announcements/schema.ts).
 * Owner decision 2026-10-12: Everyone is the fork's 'authenticated' tier (portals sit behind intranet SSO).
 */
export const EVERYONE_TENANT_AUDIENCE = { tier: 'authenticated', segmentIds: [] as string[] } as const;

export const broadcastContentSchema = z.strictObject({
 kind: z.enum(['info', 'warning', 'critical', 'maintenance', 'success']),
 title: z.string().trim().min(1).max(140),
 body: z.string().trim().max(500).nullable(),
 link: z.strictObject({ url: z.url({ protocol: /^https$/ }), label: z.string().min(1).max(60) }).nullable(),
 surfaces: z.array(z.enum(['portal', 'embed'])).min(1).refine(s => new Set(s).size === s.length, 'Duplicate surface'),
 audience: z.literal('everyone'),
 publishAt: isoDateTimeSchema.nullable(),
 expiresAt: isoDateTimeSchema.nullable(),
});
export type BroadcastContent = z.infer<typeof broadcastContentSchema>;

export const broadcastRevisionSchema = z.strictObject({
 broadcastId: uuidSchema,
 revision: z.number().int().positive(),
 content: broadcastContentSchema,
 targeting: z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all'), registryRevision: z.string().min(1) }),
  z.strictObject({ mode: z.literal('selected'), registryRevision: z.string().min(1) }),
 ]),
 /** The reviewed recipient snapshot. "All" is resolved at confirmation and never silently reduced. */
 recipients: z.array(appKeySchema).min(1).refine(r => new Set(r).size === r.length, 'Duplicate recipient'),
}).refine(r => !r.content.expiresAt || !r.content.publishAt || r.content.expiresAt > r.content.publishAt, 'Expiry must follow publication');
export type BroadcastRevision = z.infer<typeof broadcastRevisionSchema>;

export const DELIVERY_STATES = ['pending', 'blocked', 'succeeded', 'failed', 'uncertain'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

const deliveryTransitions: Record<DeliveryState, readonly DeliveryState[]> = {
 pending: ['succeeded', 'failed', 'uncertain', 'blocked'],
 blocked: ['pending'],            // prerequisites repaired, same revision and key
 failed: ['pending'],             // definite failure: retry with the same key
 uncertain: ['succeeded', 'failed'], // only via reconciliation by key, never by a blind resend
 succeeded: [],
};
export const canTransitionDelivery = (from: DeliveryState, to: DeliveryState) => deliveryTransitions[from].includes(to);

/** Stable per-app key: the same broadcast revision always maps to one tenant mutation. */
export const deliveryKey = (broadcastId: string, revision: number, appKey: string) => `resolve-broadcast:v1:${broadcastId}:${revision}:${appKey}`;

export const contentHash = (content: BroadcastContent) => payloadHash(content);

/** Tenant-side replay rule the fork must implement (QB-ANN-2); Resolve applies the same rule to its own intents. */
export function replayDecision(existing: { key: string; payloadHash: string } | undefined, incoming: { key: string; payloadHash: string }): 'new' | 'replay' | 'conflict' {
 if (!existing) return 'new';
 if (existing.key !== incoming.key) throw new Error('replayDecision compares records for the same key');
 return existing.payloadHash === incoming.payloadHash ? 'replay' : 'conflict';
}

/** Aggregate state shown to the author: never "published" while any target is unresolved. */
export function broadcastSummary(states: DeliveryState[]): 'published' | 'partial' | 'in_progress' | 'needs_attention' | 'failed' {
 if (states.every(s => s === 'succeeded')) return 'published';
 if (states.some(s => s === 'pending')) return 'in_progress';
 if (states.some(s => s === 'uncertain')) return 'needs_attention';
 if (states.some(s => s === 'succeeded')) return 'partial';
 return 'failed';
}

// ── Phase 5: tenant announcement tools (target versions; gaps QB-ANN-1/2) ──

/**
 * What Resolve sends a tenant: content only, in the fork's own field names (announcementInputSchema). Presentation
 * belongs to the fork (owner decision 2026-10-12): each application draws the banner with its own widgets and styles
 * (fork `kind-styles.ts`, `portal-banner-strip`, `banner-bar`) and keeps its own ordering (`priority`), so no colour,
 * icon, style or priority travels from Resolve. `kind` is the notice's meaning (info, warning, critical, maintenance,
 * success), which the fork maps to its appearance. Strict: any presentation field is refused.
 * Everyone ('authenticated' tier) only. Resolve schedules publication itself (owner decision), so no publishAt.
 */
export const tenantAnnouncementSchema = z.strictObject({
 kind: broadcastContentSchema.shape.kind, title: broadcastContentSchema.shape.title, body: broadcastContentSchema.shape.body,
 linkUrl: z.url({ protocol: /^https$/ }).nullable(), linkLabel: z.string().min(1).max(60).nullable(),
 surfaces: broadcastContentSchema.shape.surfaces,
 audience: z.strictObject({ tier: z.literal('authenticated'), segmentIds: z.array(z.string()).max(0) }),
 expiresAt: isoDateTimeSchema.nullable(),
});
export type TenantAnnouncement = z.infer<typeof tenantAnnouncementSchema>;
export const toTenantAnnouncement = (c: BroadcastContent): TenantAnnouncement => ({
 kind: c.kind, title: c.title, body: c.body, linkUrl: c.link?.url ?? null, linkLabel: c.link?.label ?? null, surfaces: c.surfaces,
 audience: { tier: 'authenticated', segmentIds: [] }, expiresAt: c.expiresAt,
});
const surfaceOutcome = z.strictObject({
 portal: z.enum(['published', 'not_requested']),
 /** Publication is not delivery: the embed renders only where the host app installed the banner script. */
 embed: z.enum(['published', 'not_installed', 'not_requested']),
});
export const announcementToolArgs = {
 list_announcements: z.strictObject({ includeArchived: z.boolean().optional() }),
 /** Keyed: the same key and payload hash replays; another payload under the key is refused (QB-ANN-2). Updates are version-checked. */
 upsert_announcement: z.strictObject({
  broadcastKey: z.string().max(200), payloadHash: z.string().regex(/^[0-9a-f]{64}$/), announcement: tenantAnnouncementSchema,
  announcementId: z.string().max(200).optional(), expectedVersion: z.number().int().nonnegative().optional(),
 }),
 archive_announcement: z.strictObject({ announcementId: z.string().max(200), expectedVersion: z.number().int().nonnegative() }),
 get_announcement_by_key: z.strictObject({ broadcastKey: z.string().max(200) }),
};
export const announcementToolResults = {
 list_announcements: z.object({ announcements: z.array(z.object({ announcementId: z.string(), title: z.string(), kind: z.string(), archived: z.boolean(), version: z.number().int(), broadcastKey: z.string().nullable() })) }),
 upsert_announcement: z.object({ announcementId: z.string(), version: z.number().int().nonnegative(), replayed: z.boolean(), surfaces: surfaceOutcome }),
 archive_announcement: z.object({ announcementId: z.string(), version: z.number().int().nonnegative(), archived: z.literal(true) }),
 get_announcement_by_key: z.discriminatedUnion('state', [
  z.object({ state: z.literal('committed'), announcementId: z.string(), payloadHash: z.string(), version: z.number().int(), archived: z.boolean(), surfaces: surfaceOutcome }),
  z.object({ state: z.literal('unknown') }),
 ]),
};

// ── Resolve broadcast API ──

export const broadcastTargetingSchema = z.discriminatedUnion('mode', [
 z.strictObject({ mode: z.literal('all') }),
 z.strictObject({ mode: z.literal('selected'), apps: z.array(appKeySchema).min(1, 'Choose at least one application').max(500) }),
]);
export const broadcastDraftSchema = z.strictObject({ content: broadcastContentSchema, targeting: broadcastTargetingSchema })
 .refine(d => !d.content.expiresAt || !d.content.publishAt || d.content.expiresAt > d.content.publishAt, { message: 'Expiry must follow publication', path: ['content', 'expiresAt'] })
 .refine(d => !d.content.expiresAt || Date.parse(d.content.expiresAt) > Date.now(), { message: 'Expiry must be in the future', path: ['content', 'expiresAt'] });
export const saveDraftSchema = z.strictObject({ draft: broadcastDraftSchema, version: z.number().int().nonnegative() });

export const BLOCK_REASONS = ['not_registered', 'suspended', 'not_open', 'not_connected', 'reconnect_required', 'missing_scope', 'unsupported', 'unreachable', 'author_not_authorized'] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];
export const recipientSchema = z.strictObject({
 appKey: appKeySchema, displayName: z.string(),
 state: z.enum(['ready', 'blocked']), reason: z.enum(BLOCK_REASONS).nullable(),
});
export const broadcastReviewSchema = z.strictObject({
 broadcastId: uuidSchema, revision: z.number().int().positive(),
 /** Binds publication to exactly this content, targeting and recipient readiness. */
 reviewHash: z.string().regex(/^[0-9a-f]{64}$/),
 registryRevision: z.string(),
 recipients: z.array(recipientSchema),
 /** Scheduled "All apps": apps registered before the publish time are included too (owner decision). */
 followsRegistry: z.boolean(),
});
export type BroadcastReview = z.infer<typeof broadcastReviewSchema>;
export const publishSchema = z.strictObject({ reviewHash: z.string().regex(/^[0-9a-f]{64}$/), requestId: uuidSchema, confirmPartial: z.boolean() });
export const reviseSchema = z.strictObject({ content: broadcastContentSchema, version: z.number().int().nonnegative(), requestId: uuidSchema });
export const archiveSchema = z.strictObject({ requestId: uuidSchema });

export const BROADCAST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'partial', 'needs_attention', 'failed', 'archived'] as const;
export const deliveryViewSchema = z.strictObject({
 appKey: appKeySchema, displayName: z.string(), revision: z.number().int().positive(),
 state: z.enum(DELIVERY_STATES), reason: z.enum(BLOCK_REASONS).nullable(), failureCode: z.string().nullable(),
 announcementId: z.string().nullable(), surfaces: surfaceOutcome.nullable(),
 archive: z.strictObject({ state: z.enum(['pending', 'succeeded', 'failed', 'conflict', 'uncertain']), failureCode: z.string().nullable() }).nullable(),
 updatedAt: isoDateTimeSchema,
});
export type DeliveryView = z.infer<typeof deliveryViewSchema>;
export const broadcastViewSchema = z.strictObject({
 id: uuidSchema, status: z.enum(BROADCAST_STATUSES), author: z.string(), createdAt: isoDateTimeSchema, updatedAt: isoDateTimeSchema,
 version: z.number().int().nonnegative(), revision: z.number().int().positive(),
 content: broadcastContentSchema, targeting: broadcastTargetingSchema,
 deliveries: z.array(deliveryViewSchema),
 /** Only the author may act: deliveries are published as them. */
 canAct: z.boolean(),
 /** Plain-language next steps (blocked apps, uncertain results, scheduled time). */
 notes: z.array(z.string()),
});
export type BroadcastView = z.infer<typeof broadcastViewSchema>;
export const broadcastListSchema = z.strictObject({
 broadcasts: z.array(z.strictObject({ id: uuidSchema, title: z.string(), kind: z.string(), status: z.enum(BROADCAST_STATUSES), author: z.string(), updatedAt: isoDateTimeSchema,
  recipients: z.number().int(), succeeded: z.number().int() })),
});
