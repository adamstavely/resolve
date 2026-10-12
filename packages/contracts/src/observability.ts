import { z } from 'zod';
import { appKeySchema, failureCodeSchema, isoDateTimeSchema, uuidSchema } from './common';

/*
 * Elastic Observability integration (plan 12, plan 14). Resolve-normalized DTOs, not Elastic's wire shapes: the
 * adapter (apps/api/lib/integrations/elastic) parses each Elastic API family into these. Every read carries where
 * and when it came from and how complete it is; absence of data is never "healthy".
 */
export const OBSERVABILITY_SCHEMA_VERSION = 1;

/** Elastic API families Resolve uses. Discovery records each one as supported, unsupported or denied. */
export const ELASTIC_FAMILIES = ['slo', 'alerts', 'synthetics', 'apm', 'rum', 'logs', 'cases'] as const;
export type ElasticFamily = (typeof ELASTIC_FAMILIES)[number];
export const FAMILY_LABEL: Record<ElasticFamily, string> = {
 slo: 'SLOs', alerts: 'Alerts', synthetics: 'Synthetics', apm: 'APM traces and errors', rum: 'Real user monitoring', logs: 'Logs', cases: 'Cases',
};

export const HEALTH_STATES = ['unknown', 'healthy', 'degraded', 'critical', 'stale'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];
export const COMPLETENESS = ['complete', 'partial', 'unavailable'] as const;
export type Completeness = (typeof COMPLETENESS)[number];

/** Provenance on every observability read (plan 12 §5). */
export const provenanceSchema = z.strictObject({
 schemaVersion: z.literal(OBSERVABILITY_SCHEMA_VERSION),
 appKey: appKeySchema,
 environment: z.string().min(1).max(64),
 connectionRevision: z.number().int().nonnegative(),
 mappingRevision: z.number().int().nonnegative(),
 observedAt: isoDateTimeSchema.nullable(),
 fetchedAt: isoDateTimeSchema,
 expiresAt: isoDateTimeSchema,
 completeness: z.enum(COMPLETENESS),
 /** Families that were expected but missing, so "partial" always says what is missing. */
 missing: z.array(z.enum(ELASTIC_FAMILIES)),
});
export type Provenance = z.infer<typeof provenanceSchema>;

// ── Connection administration (E0) ──

/** Index/data-stream expressions an admin may approve: no leading dot or minus, no bare `*`, no cross-cluster `:`. */
export const indexPatternSchema = z.string().max(120).regex(/^[a-z0-9][a-z0-9._*-]*$/, 'Use lowercase index or data-stream names; a wildcard may not stand alone')
 .refine(p => p.replace(/\*/g, '').length >= 3, 'Name at least three characters of the index or data stream');
/** Elastic object ids (SLO, monitor, rule) used in paths and term filters. */
export const elasticIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/, 'Use the id as Elastic shows it (letters, digits, hyphens, underscores)');
export const kibanaSpaceSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/, 'Space IDs are lowercase letters, digits, hyphens and underscores');

const httpUrl = z.url().refine(u => /^https?:$/.test(new URL(u).protocol), 'Use an http(s) URL').transform(u => new URL(u).origin)
 .describe('Origin only; paths are added by the adapter.');

export const elasticConnectionCreateSchema = z.strictObject({
 name: z.string().trim().min(1).max(80),
 elasticsearchUrl: httpUrl,
 kibanaUrl: httpUrl,
 spaceId: kibanaSpaceSchema,
 /** Read-only API key (base64 `id:key` as Elastic issues it). Write-only: never returned. */
 apiKey: z.string().trim().min(16).max(512).optional(),
 /** Production: a secret-store reference instead of a sealed key, e.g. `env:ELASTIC_PROD_API_KEY`. */
 secretRef: z.string().regex(/^env:[A-Z][A-Z0-9_]{2,63}$/).optional(),
 /** PEM bundle for the private CA. Certificate verification is never disabled. */
 caPem: z.string().max(20_000).regex(/-----BEGIN CERTIFICATE-----/).optional(),
}).refine(c => !!c.apiKey !== !!c.secretRef, { message: 'Provide either an API key or a secret reference', path: ['apiKey'] });
export type ElasticConnectionCreate = z.infer<typeof elasticConnectionCreateSchema>;

export const credentialRotateSchema = z.strictObject({
 apiKey: z.string().trim().min(16).max(512).optional(),
 secretRef: z.string().regex(/^env:[A-Z][A-Z0-9_]{2,63}$/).optional(),
 version: z.number().int().nonnegative(),
}).refine(c => !!c.apiKey !== !!c.secretRef, { message: 'Provide either an API key or a secret reference', path: ['apiKey'] });

export const connectionSwitchSchema = z.strictObject({
 /** Kill switch: stops all polling and reads for this connection at once; evidence and audit are kept. */
 killSwitch: z.boolean(),
 reason: z.string().trim().min(3).max(300),
 version: z.number().int().nonnegative(),
});

export const FAMILY_STATUS = ['supported', 'unsupported', 'denied', 'error'] as const;
export type FamilyStatus = (typeof FAMILY_STATUS)[number];
export const familyCheckSchema = z.strictObject({
 status: z.enum(FAMILY_STATUS),
 /** Redacted failure code or Elastic error type; never response bodies. */
 code: z.string().max(80).nullable(),
});
export const discoverySchema = z.strictObject({
 checkedAt: isoDateTimeSchema,
 elasticsearch: z.strictObject({ version: z.string().nullable(), buildFlavor: z.string().nullable() }),
 kibana: z.strictObject({ version: z.string().nullable(), buildFlavor: z.string().nullable() }),
 reachable: z.boolean(),
 failure: failureCodeSchema.nullable(),
 families: z.record(z.enum(ELASTIC_FAMILIES), familyCheckSchema),
});
export type Discovery = z.infer<typeof discoverySchema>;

export const elasticConnectionSchema = z.strictObject({
 id: uuidSchema,
 provider: z.literal('elastic'),
 name: z.string(),
 elasticsearchUrl: z.string(),
 kibanaUrl: z.string(),
 spaceId: z.string(),
 credential: z.strictObject({ kind: z.enum(['sealed', 'secret_ref']), ref: z.string().nullable(), rotatedAt: isoDateTimeSchema }),
 hasCustomCa: z.boolean(),
 killSwitch: z.boolean(),
 killSwitchReason: z.string().nullable(),
 discovery: discoverySchema.nullable(),
 revision: z.number().int().nonnegative(),
 version: z.number().int().nonnegative(),
 createdAt: isoDateTimeSchema,
 updatedAt: isoDateTimeSchema,
});
export type ElasticConnection = z.infer<typeof elasticConnectionSchema>;
export const elasticConnectionListSchema = z.strictObject({ connections: z.array(elasticConnectionSchema) });

// ── App mappings (configured in E1; the shape is fixed here so migration 0008 matches) ──

export const serviceSelectorSchema = z.strictObject({
 name: z.string().min(1).max(120),
 environment: z.string().min(1).max(64),
 /** A service shared by several apps needs a discriminator; a service name alone is not a tenant boundary. */
 discriminator: z.strictObject({ field: z.enum(['labels.app', 'service.namespace']), value: z.string().min(1).max(120) }).nullable(),
});
export const elasticAppMappingSchema = z.strictObject({
 appKey: appKeySchema,
 environment: z.string().min(1).max(64),
 connectionId: uuidSchema,
 indices: z.strictObject({
  apm: z.array(indexPatternSchema).max(10), rum: z.array(indexPatternSchema).max(10),
  logs: z.array(indexPatternSchema).max(10), synthetics: z.array(indexPatternSchema).max(10),
 }),
 services: z.array(serviceSelectorSchema).min(1).max(20),
 sloIds: z.array(elasticIdSchema).max(50),
 monitorIds: z.array(elasticIdSchema).max(100),
 alertRuleIds: z.array(elasticIdSchema).max(50),
 caseTags: z.array(z.string().min(1).max(80)).max(10),
 deepLinkBase: z.url().nullable(),
 subjectPolicy: z.enum(['verified_external_id', 'none']),
});
export type ElasticAppMapping = z.infer<typeof elasticAppMappingSchema>;

// ── Normalized family results (what the adapter returns; E1/E2 compose them into health and context) ──

export const sloResultSchema = z.strictObject({
 sloId: z.string(), name: z.string(),
 target: z.number().min(0).max(1),
 window: z.strictObject({ duration: z.string(), type: z.enum(['rolling', 'calendarAligned']) }),
 status: z.enum(['healthy', 'degrading', 'violated', 'no_data']),
 sliValue: z.number().nullable(),
 errorBudgetRemaining: z.number().nullable(),
 /** Only when the SLO API reports it for its own window; never derived from a percentage. */
 burnRate: z.strictObject({ window: z.string(), value: z.number() }).nullable(),
});
export type SloResult = z.infer<typeof sloResultSchema>;

export const alertResultSchema = z.strictObject({
 alertId: z.string(), ruleId: z.string(), ruleName: z.string(),
 status: z.enum(['active', 'recovered', 'untracked']),
 startedAt: isoDateTimeSchema, service: z.string().nullable(), environment: z.string().nullable(),
 /** Redacted reason text (plan 12 §8). */
 reason: z.string().max(500).nullable(),
});
export type AlertResult = z.infer<typeof alertResultSchema>;

export const syntheticResultSchema = z.strictObject({
 monitorId: z.string(), name: z.string(), location: z.string(),
 status: z.enum(['up', 'down']), durationMs: z.number().nullable(), checkedAt: isoDateTimeSchema,
});
export type SyntheticResult = z.infer<typeof syntheticResultSchema>;

export const caseResultSchema = z.strictObject({
 caseId: z.string(), title: z.string().max(300), status: z.enum(['open', 'in-progress', 'closed']),
 tags: z.array(z.string()), createdAt: isoDateTimeSchema, updatedAt: isoDateTimeSchema.nullable(), totalAlerts: z.number().int().nonnegative(),
});
export type CaseResult = z.infer<typeof caseResultSchema>;

export const subjectEventSchema = z.strictObject({
 at: isoDateTimeSchema,
 source: z.enum(['APM', 'RUM']),
 kind: z.enum(['error', 'transaction', 'page_load']),
 service: z.string(), name: z.string().max(200),
 outcome: z.enum(['success', 'failure', 'unknown']),
 httpStatus: z.number().int().nullable(),
 durationMs: z.number().nullable(),
 /** Restricted: only returned to observability.restricted. */
 traceId: z.string().nullable(), transactionId: z.string().nullable(),
 region: z.string().nullable(),
});
export type SubjectEvent = z.infer<typeof subjectEventSchema>;

// ── Customer identity from the tenant (QB-OBS-1) ──

export const customerIdentityArgs = z.union([
 z.strictObject({ conversationId: z.string().min(1) }),
 z.strictObject({ ticketId: z.string().min(1) }),
]);
/** Only the signed-token identify path sets a verified external id; anything else is reported as unverified, with no id. */
export const customerIdentityResult = z.discriminatedUnion('verified', [
 z.object({ verified: z.literal(true), externalId: z.string().min(1).max(255) }),
 z.object({ verified: z.literal(false), externalId: z.null() }),
]);
export type CustomerIdentity = z.infer<typeof customerIdentityResult>;
