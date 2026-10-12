import { z } from 'zod';
import { OUTCOMES } from './audit';
import { isoDateTimeSchema, uuidSchema } from './common';

/* Phase 1 admin API (fleet-admin only): emergency access blocks, audit reading, tenant client registration. */

export const DISABLED_REASONS = ['manual', 'directory', 'directory_absent'] as const;

export const adminUserSchema = z.strictObject({
 id: uuidSchema,
 displayName: z.string(),
 email: z.string().nullable(),
 enabled: z.boolean(),
 disabledReason: z.enum(DISABLED_REASONS).nullable(),
 bundles: z.array(z.string()),
 /** Bundles granted by an admin (the rest come from IdP groups at sign-in). */
 manualBundles: z.array(z.string()),
 lastLoginAt: isoDateTimeSchema.nullable(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;
export const adminUsersResponseSchema = z.strictObject({ users: z.array(adminUserSchema) });

/** POST /api/admin/users/:id/access. A reason is mandatory and recorded in the audit. */
export const accessChangeSchema = z.strictObject({
 enabled: z.boolean(),
 reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500),
});

/** PUT /api/admin/apps/:appKey/client. The secret is sealed on receipt and never returned. */
export const tenantClientRegistrationSchema = z.strictObject({
 clientId: z.string().trim().min(1).max(200),
 clientSecret: z.string().min(16).max(1000),
});

/** Operation prefixes: sign-in, app connections, people, conversation and ticket actions, reads, refused requests, app admin, availability, entitlement sync. */
export const AUDIT_CATEGORIES = ['session', 'grant', 'user', 'conversation', 'ticket', 'read', 'access', 'app', 'presence', 'entitlement', 'broadcast', 'observability'] as const;

/** GET /api/audit query. `before` is the opaque cursor from the previous page. */
export const auditQuerySchema = z.strictObject({
 category: z.enum(AUDIT_CATEGORIES).optional(),
 outcome: z.enum(OUTCOMES).optional(),
 limit: z.coerce.number().int().min(1).max(100).default(50),
 before: z.string().max(200).optional(),
});

export const auditEventSchema = z.strictObject({
 id: uuidSchema,
 at: isoDateTimeSchema,
 operation: z.string(),
 outcome: z.enum(OUTCOMES),
 /** The human who acted, or the system executor (e.g. directory-sync). */
 actor: z.string(),
 actorType: z.enum(['human', 'system']),
 summary: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
 /** Full text of a reply or note, for audit readers only (owner decision). */
 content: z.string().nullable(),
});
export const auditPageSchema = z.strictObject({ events: z.array(auditEventSchema), nextCursor: z.string().nullable() });
export type AuditEvent = z.infer<typeof auditEventSchema>;
