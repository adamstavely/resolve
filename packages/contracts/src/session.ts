import { z } from 'zod';
import { BUNDLES, CAPABILITIES, type BundleId, type CapabilityId } from './capabilities';
import { uuidSchema } from './common';

/** GET /api/session. Capabilities are for display; every API endpoint enforces them again. */
export const sessionResponseSchema = z.discriminatedUnion('authenticated', [
 z.strictObject({ authenticated: z.literal(false) }),
 z.strictObject({
  authenticated: z.literal(true),
  user: z.strictObject({ id: uuidSchema, displayName: z.string(), email: z.string().nullable() }),
  bundles: z.array(z.enum(Object.keys(BUNDLES) as [BundleId, ...BundleId[]])),
  capabilities: z.array(z.enum(Object.keys(CAPABILITIES) as [CapabilityId, ...CapabilityId[]])),
 }),
]);
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const BUNDLE_LABELS: Record<BundleId, string> = {
 'fleet-admin': 'Fleet admin', 'fleet-agent': 'Fleet agent', 'fleet-observer': 'Fleet observer', 'announcement-author': 'Announcement author',
};
