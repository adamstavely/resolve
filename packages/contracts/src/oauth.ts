import { z } from 'zod';
import { appKeySchema, isoDateTimeSchema, sha256HexSchema, uuidSchema } from './common';

/*
 * Contract 2 (plan 01): human OAuth connect. Confidential client per tenant, exact redirect URI,
 * PKCE S256, single-use state bound to Resolve session, user and app, and an expiring attempt.
 * Only hashes of state and session are stored; the raw values exist in the browser redirect only.
 */

export const GRANT_STATES = ['not_connected', 'connecting', 'connected', 'reconnect_required', 'revoked', 'denied'] as const;
export type GrantState = (typeof GRANT_STATES)[number];

export const connectAttemptSchema = z.strictObject({
 attemptId: uuidSchema,
 userId: uuidSchema,
 appKey: appKeySchema,
 sessionHash: sha256HexSchema,
 stateHash: sha256HexSchema,
 codeChallengeMethod: z.literal('S256'),
 redirectUri: z.url({ protocol: /^https$/ }),
 expiresAt: isoDateTimeSchema,
 consumedAt: isoDateTimeSchema.nullable(),
});
export type ConnectAttempt = z.infer<typeof connectAttemptSchema>;

/** Callback query: success or an authorization-server error, always with state. */
export const callbackQuerySchema = z.union([
 z.strictObject({ code: z.string().min(1).max(2048), state: z.string().min(16).max(512), iss: z.url().optional() }),
 z.strictObject({ error: z.string().max(100), error_description: z.string().max(500).optional(), state: z.string().min(16).max(512), iss: z.url().optional() }),
]);

export type CallbackRejection = 'unknown_state' | 'consumed' | 'expired' | 'wrong_session' | 'wrong_user' | 'wrong_app';

/**
 * Bind a callback to its attempt before any token exchange. The caller looked the attempt up by
 * stateHash; this checks every other binding. Consuming the attempt must be atomic with this check.
 */
export function checkCallbackBinding(
 attempt: ConnectAttempt | undefined,
 callback: { sessionHash: string; userId: string; appKey: string; now: Date },
): { ok: true } | { ok: false; reason: CallbackRejection } {
 if (!attempt) return { ok: false, reason: 'unknown_state' };
 if (attempt.consumedAt) return { ok: false, reason: 'consumed' };
 if (new Date(attempt.expiresAt) <= callback.now) return { ok: false, reason: 'expired' };
 if (attempt.sessionHash !== callback.sessionHash) return { ok: false, reason: 'wrong_session' };
 if (attempt.userId !== callback.userId) return { ok: false, reason: 'wrong_user' };
 if (attempt.appKey !== callback.appKey) return { ok: false, reason: 'wrong_app' };
 return { ok: true };
}

/** Identity claims after signature, issuer and audience verification. Email is display data, never a key. */
export const verifiedTenantIdentitySchema = z.strictObject({
 issuer: z.url(),
 audience: z.string().min(1),
 subject: z.string().min(1).max(255),
 tenantUserId: z.string().min(1),
 tenantPrincipalId: z.string().min(1),
});
export type VerifiedTenantIdentity = z.infer<typeof verifiedTenantIdentitySchema>;

export interface TenantIdentityLink { appKey: string; issuer: string; subject: string; tenantUserId: string; tenantPrincipalId: string }
export type IdentityMismatch = 'issuer' | 'subject' | 'tenant_user' | 'tenant_principal';

/**
 * Before storing a grant, the tenant identity must equal the persisted mapping for this user and app
 * (plan 02: issuer/subject pairs, not email). No mapping means no grant; linking happens elsewhere.
 */
export function checkIdentityMapping(link: TenantIdentityLink | undefined, claims: VerifiedTenantIdentity): IdentityMismatch[] | 'unmapped' {
 if (!link) return 'unmapped';
 const out: IdentityMismatch[] = [];
 if (link.issuer !== claims.issuer) out.push('issuer');
 if (link.subject !== claims.subject) out.push('subject');
 if (link.tenantUserId !== claims.tenantUserId) out.push('tenant_user');
 if (link.tenantPrincipalId !== claims.tenantPrincipalId) out.push('tenant_principal');
 return out;
}
