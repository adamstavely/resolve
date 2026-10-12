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
 'observability-investigator': 'Observability investigator',
};

/** GET /api/apps: registered apps with the caller's own connection to each. */
export const appsResponseSchema = z.strictObject({
 registryRevision: z.string(),
 apps: z.array(z.strictObject({
  appKey: z.string(),
  displayName: z.string(),
  /** One-line description from onboarding; null for applications Resolve did not register. */
  description: z.string().nullable(),
  state: z.string(),
  servable: z.boolean(),
  dormant: z.boolean(),
  /** Tenant protocol/tool compatibility (contract 6). Dormant and unavailable apps are not probed. */
  health: z.strictObject({ status: z.enum(['ok', 'incompatible', 'unreachable', 'not_checked']), reasons: z.array(z.string()), checkedAt: z.string().nullable() }),
  connection: z.strictObject({
   state: z.enum(['not_connected', 'connecting', 'connected', 'reconnect_required', 'revoked', 'denied']),
   scopes: z.array(z.string()),
   tenantUserId: z.string().nullable(),
  }),
 })),
});
export type AppsResponse = z.infer<typeof appsResponseSchema>;

/** GET /api/apps/:appKey/whoami: the tenant's view of the caller, fetched with the caller's own grant. */
export const whoamiResponseSchema = z.strictObject({ app: z.string(), tenantUserId: z.string(), principalId: z.string(), scopes: z.array(z.string()) });
