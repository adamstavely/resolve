import { z } from 'zod';
import { appKeySchema, isoDateTimeSchema, uuidSchema } from './common';

/*
 * Contract 5 (plan 01): audit. The operation ID links Resolve intent to the tenant or worker result.
 * Human actions record the human; background directory work records its source event, not a person.
 */
export const OUTCOMES = ['pending', 'succeeded', 'failed', 'uncertain', 'denied'] as const;
export type Outcome = (typeof OUTCOMES)[number];

const summaryValue = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

export const auditOperationSchema = z.strictObject({
 operationId: uuidSchema,
 actor: z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('human'), userId: uuidSchema, issuer: z.url(), subject: z.string().min(1), tenantPrincipalId: z.string().nullable() }),
  z.strictObject({ type: z.literal('system'), executor: z.string().min(1), sourceEvent: z.string().min(1), sourceVersion: z.string().min(1) }),
 ]),
 appKey: appKeySchema.nullable(),
 operation: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/),
 parameterSummary: z.record(z.string(), summaryValue),
 outcome: z.enum(OUTCOMES),
 tenantCorrelation: z.strictObject({ recordId: z.string().nullable(), auditId: z.string().nullable() }).nullable(),
 /** When authorization was last checked and when the action was dispatched (plan 02). */
 authorizedAt: isoDateTimeSchema,
 dispatchedAt: isoDateTimeSchema.nullable(),
});
export type AuditOperation = z.infer<typeof auditOperationSchema>;

const SECRET_KEY = /token|secret|password|passphrase|dsn|credential|authorization|cookie|api[-_]?key|private[-_]?key|session/i;

/**
 * Keep only allowlisted, non-secret parameters, truncated. A secret-looking key is dropped even if allowlisted,
 * and free text (message bodies) should not be allowlisted at all; summaries record shape, not content.
 */
export function redactParameters(params: Record<string, unknown>, allow: readonly string[]): Record<string, string | number | boolean | null> {
 const out: Record<string, string | number | boolean | null> = {};
 for (const key of allow) {
  if (SECRET_KEY.test(key) || !(key in params)) continue;
  const v = params[key];
  if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[key] = v;
  else if (typeof v === 'string') out[key] = v.length > 200 ? v.slice(0, 199) + '…' : v;
  else if (Array.isArray(v)) out[key] = `[${v.length} items]`;
  else out[key] = '[omitted]';
 }
 return out;
}
