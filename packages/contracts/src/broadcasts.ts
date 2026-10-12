import { z } from 'zod';
import { appKeySchema, isoDateTimeSchema, payloadHash, uuidSchema } from './common';

/*
 * Banner broadcasts (plan 08). Everyone audience only; recipients are an explicit snapshot reviewed by
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
