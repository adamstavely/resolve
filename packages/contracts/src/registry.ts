import { z } from 'zod';
import { appKeySchema, isoDateTimeSchema } from './common';

/*
 * Contract 1 (plan 01): registry read. A versioned, column-limited projection supplied by the
 * Quackback fleet adapter (gap QB-REG-1). Strict: a DSN, secret reference, credential or any other
 * unlisted field fails parsing instead of being silently carried into Resolve.
 */
export const REGISTRY_STATES = ['provisioning', 'maintenance', 'active', 'suspended', 'retired'] as const;
export type RegistryState = (typeof REGISTRY_STATES)[number] | 'unknown';

export const registryAppSchema = z.strictObject({
 appKey: appKeySchema,
 displayName: z.string().min(1).max(120),
 /** Canonical support origin (scheme, host, optional port; no path). The tenant OAuth issuer is `${origin}/api/auth`. */
 supportOrigin: z.url({ protocol: /^https?$/ }).refine(u => new URL(u).origin === u, 'An origin without path, query or trailing slash'),
 /** The fleet adapter's routability decision; Resolve never derives it from state alone. */
 routable: z.boolean(),
 /** Unknown tenant states map to 'unknown' and are treated as unavailable. */
 state: z.string().transform((s): RegistryState => (REGISTRY_STATES as readonly string[]).includes(s) ? s as RegistryState : 'unknown'),
 deploymentVersion: z.string().min(1).max(100),
 protocolVersions: z.array(z.number().int().positive()).min(1),
 lastActivityAt: isoDateTimeSchema.nullable(),
});
export type RegistryApp = z.infer<typeof registryAppSchema>;

export const registryPageSchema = z.strictObject({
 schemaVersion: z.literal(1),
 /** Registry revision; broadcast recipient snapshots store it (plan 08). */
 revision: z.string().min(1),
 apps: z.array(registryAppSchema),
});

/** Normal user traffic is only ever sent to an active, routable app. */
export const isServable = (app: RegistryApp) => app.state === 'active' && app.routable;
