import { z } from 'zod';
import { appKeySchema, failureCodeSchema, isoDateTimeSchema, sha256HexSchema, uuidSchema } from './common';

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

// ── E1: app mappings (administration) ──

export const mappingStateSchema = z.enum(['draft', 'active', 'disabled']);
/** One family's preview result: what this mapping actually finds, so an admin sees gaps before activating. */
export const previewFamilySchema = z.strictObject({
 family: z.enum(ELASTIC_FAMILIES),
 status: z.enum(['ok', 'empty', 'missing', 'denied', 'error', 'not_configured']),
 found: z.number().int().nonnegative(),
 /** Configured ids Elastic does not know (SLO ids), or monitors with no executed result in the last 24 hours. */
 missingIds: z.array(z.string()),
 code: z.string().nullable(),
});
export const mappingPreviewSchema = z.strictObject({
 checkedAt: isoDateTimeSchema,
 passed: z.boolean(),
 families: z.array(previewFamilySchema),
 /** Events for the known test subject in the last 24 hours (null when none was given). */
 testSubjectEvents: z.number().int().nonnegative().nullable(),
});
export type MappingPreview = z.infer<typeof mappingPreviewSchema>;
export const isolationResultSchema = z.strictObject({
 checkedAt: isoDateTimeSchema,
 passed: z.boolean(),
 /** Every other mapping on the same connection, and what this mapping's selectors share with it. */
 comparedWith: z.array(z.strictObject({
  appKey: appKeySchema, environment: z.string(),
  overlappingEvents: z.number().int().nonnegative(),
  sharedIds: z.array(z.string()),
 })),
});
export type IsolationResult = z.infer<typeof isolationResultSchema>;

export const mappingViewSchema = z.strictObject({
 appKey: appKeySchema,
 environment: z.string(),
 mapping: elasticAppMappingSchema,
 state: mappingStateSchema,
 revision: z.number().int().positive(),
 version: z.number().int().nonnegative(),
 preview: mappingPreviewSchema.nullable(),
 isolation: isolationResultSchema.nullable(),
 updatedAt: isoDateTimeSchema,
});
export type MappingView = z.infer<typeof mappingViewSchema>;
export const mappingListSchema = z.strictObject({ mappings: z.array(mappingViewSchema) });
export const mappingSaveSchema = z.strictObject({ mapping: elasticAppMappingSchema, version: z.number().int().nonnegative().nullable() });
export const mappingPreviewRequestSchema = z.strictObject({ testSubject: z.string().trim().min(1).max(255).optional() });
export const mappingStateRequestSchema = z.strictObject({ state: z.enum(['active', 'disabled']), version: z.number().int().nonnegative() });

// ── E1: health and known issues (read models) ──

export const healthComponentSchema = z.strictObject({
 family: z.enum(['slo', 'alerts', 'synthetics']),
 /** SLO id, `alerts`, or `monitorId@location`. */
 key: z.string(),
 label: z.string(),
 state: z.enum(HEALTH_STATES),
 /** Plain-language fact, e.g. "99.61% against 99.5%, budget 22% left, burning 4.2x (1h)". */
 detail: z.string().max(300),
});
export type HealthComponent = z.infer<typeof healthComponentSchema>;

export const HEALTH_REASONS = ['not_configured', 'kill_switch', 'connection_unavailable', 'not_polled_yet'] as const;
export const appHealthSchema = z.strictObject({
 appKey: appKeySchema,
 environment: z.string(),
 state: z.enum(HEALTH_STATES),
 /** Why there is no current health (null when there is). */
 reason: z.enum(HEALTH_REASONS).nullable(),
 provenance: provenanceSchema.nullable(),
 components: z.array(healthComponentSchema),
 summary: z.strictObject({
  slos: z.strictObject({ total: z.number().int(), healthy: z.number().int(), degrading: z.number().int(), violated: z.number().int(), noData: z.number().int(),
   /** The highest burn rate an SLO reported, with its SLO, when any did. */
   worstBurn: z.strictObject({ sloId: z.string(), name: z.string(), target: z.number(), window: z.string(), value: z.number() }).nullable() }),
  activeAlerts: z.number().int(),
  synthetics: z.strictObject({
   /** Latest result per monitor and location. */
   passing: z.number().int(), total: z.number().int(), failing: z.array(z.string()),
   /** Monitors the mapping names; with no results in the window the card says so instead of hiding the row. */
   configured: z.number().int(),
   /** The most recent executed runs across the mapped monitors, oldest first (the card's run strip). */
   recent: z.array(z.strictObject({ status: z.enum(['up', 'down']), label: z.string(), checkedAt: isoDateTimeSchema })).max(12),
  }),
 }),
});
export type AppHealth = z.infer<typeof appHealthSchema>;
export const fleetHealthSchema = z.strictObject({ apps: z.array(appHealthSchema), pollSeconds: z.number().int().positive() });
export type FleetHealth = z.infer<typeof fleetHealthSchema>;

export const knownIssueSchema = z.strictObject({
 id: uuidSchema,
 appKey: appKeySchema,
 environment: z.string(),
 kind: z.enum(['alert', 'case']),
 providerId: z.string(),
 title: z.string(),
 state: z.enum(['active', 'recovered', 'closed']),
 since: isoDateTimeSchema,
 lastSeenAt: isoDateTimeSchema,
 service: z.string().nullable(),
 /** Distinct instrumented subjects with errors on the mapped services since the issue started. */
 affected: z.strictObject({ count: z.number().int().nonnegative(), approximate: z.literal(true), since: isoDateTimeSchema, measuredAt: isoDateTimeSchema }).nullable(),
 linkedTickets: z.number().int().nonnegative(),
});
export type KnownIssue = z.infer<typeof knownIssueSchema>;
export const knownIssueListSchema = z.strictObject({ issues: z.array(knownIssueSchema) });

/** A ticket that might belong to an issue. Never linked without a person confirming it. */
export const linkCandidateSchema = z.strictObject({
 ticketId: z.string(),
 reference: z.string(),
 title: z.string(),
 updatedAt: isoDateTimeSchema,
 matched: z.array(z.string()),
 missing: z.array(z.string()),
 /** Pre-selected in the review: only when nothing that is checkable disagrees. */
 suggested: z.boolean(),
 linked: z.boolean(),
});
export type LinkCandidate = z.infer<typeof linkCandidateSchema>;
export const linkCandidatesSchema = z.strictObject({ issue: knownIssueSchema, candidates: z.array(linkCandidateSchema), coverage: z.string() });
export const linkRequestSchema = z.strictObject({ requestId: uuidSchema, ticketIds: z.array(z.string().min(1).max(200)).min(1).max(100) });
export const linkResultSchema = z.strictObject({ linked: z.array(z.string()), alreadyLinked: z.array(z.string()), refused: z.array(z.strictObject({ ticketId: z.string(), reason: z.string() })) });

/** Content-free invalidation on the observability stream; the browser re-reads with its own authority. */
export const observabilityEventSchema = z.discriminatedUnion('type', [
 z.strictObject({ type: z.literal('ready') }),
 z.strictObject({ type: z.literal('health'), appKey: appKeySchema, environment: z.string(), at: isoDateTimeSchema }),
 z.strictObject({ type: z.literal('issues'), appKey: appKeySchema, environment: z.string(), at: isoDateTimeSchema }),
]);
export type ObservabilityEvent = z.infer<typeof observabilityEventSchema>;

// ── E2: customer context and evidence snapshots ──

export const SUBJECT_STATUS = ['verified', 'unverified', 'not_reported', 'not_mapped', 'policy_none', 'unavailable'] as const;
export type SubjectStatus = (typeof SUBJECT_STATUS)[number];

export const subjectLogSchema = z.strictObject({
 at: isoDateTimeSchema, level: z.string().max(20).nullable(), service: z.string().nullable(),
 /** Redacted before it leaves the server. */
 message: z.string().max(500), traceId: z.string().nullable(),
});
export type SubjectLog = z.infer<typeof subjectLogSchema>;

export const matchedIssueSchema = z.strictObject({
 issueId: uuidSchema, title: z.string(), kind: z.enum(['alert', 'case']), providerId: z.string(), since: isoDateTimeSchema,
 /** Criteria that held, and those that could not be checked or did not hold. Time overlap alone is not causation. */
 matched: z.array(z.string()), missing: z.array(z.string()),
 /** This customer's events (errors) on the issue's service since it began. */
 customerErrorsInWindow: z.number().int().nonnegative(),
});
export type MatchedIssue = z.infer<typeof matchedIssueSchema>;

export const subjectContextSchema = z.strictObject({
 appKey: appKeySchema,
 objectKind: z.enum(['ticket', 'conversation']),
 objectId: z.string(),
 subject: z.strictObject({ status: z.enum(SUBJECT_STATUS), externalId: z.string().nullable() }),
 window: z.strictObject({ from: isoDateTimeSchema, to: isoDateTimeSchema }),
 fetchedAt: isoDateTimeSchema,
 completeness: z.enum(COMPLETENESS),
 missing: z.array(z.enum(ELASTIC_FAMILIES)),
 /** Whether trace ids, log lines and Kibana links were included (observability.restricted). */
 restricted: z.boolean(),
 events: z.array(subjectEventSchema),
 logs: z.array(subjectLogSchema),
 lastSession: z.strictObject({ region: z.string(), at: isoDateTimeSchema }).nullable(),
 synthetics: z.array(syntheticResultSchema),
 matchedIssues: z.array(matchedIssueSchema),
 /** APM sampling and RUM coverage are not complete records; the panel says so. */
 coverage: z.string(),
 kibanaTraceBase: z.string().nullable(),
});
export type SubjectContext = z.infer<typeof subjectContextSchema>;

export const evidenceFactsSchema = z.strictObject({
 health: appHealthSchema.nullable(),
 issues: z.array(matchedIssueSchema),
 events: z.array(subjectEventSchema),
 lastSession: subjectContextSchema.shape.lastSession,
 synthetics: z.array(syntheticResultSchema),
 alreadyTried: z.array(z.strictObject({ at: isoDateTimeSchema, operation: z.string(), actor: z.string(), outcome: z.string() })),
 /** Trace ids and log lines; shown only to observability.restricted. */
 restricted: z.strictObject({ logs: z.array(subjectLogSchema), traces: z.array(z.strictObject({ traceId: z.string(), transactionId: z.string().nullable(), at: isoDateTimeSchema })) }),
});
export type EvidenceFacts = z.infer<typeof evidenceFactsSchema>;

export const evidenceSnapshotSchema = z.strictObject({
 id: uuidSchema, previousId: uuidSchema.nullable(),
 appKey: appKeySchema, environment: z.string(), objectKind: z.enum(['ticket', 'conversation']), objectId: z.string(),
 subjectStatus: z.enum(SUBJECT_STATUS),
 requested: z.strictObject({ from: isoDateTimeSchema, to: isoDateTimeSchema }),
 capturedAt: isoDateTimeSchema, capturedBy: z.string(), expiresAt: isoDateTimeSchema,
 completeness: z.enum(COMPLETENESS), classification: z.enum(['service', 'subject', 'restricted']),
 contentHash: sha256HexSchema,
 /** Recomputed on every view: the stored facts still produce the recorded hash. Consistency, not truth. */
 hashVerified: z.boolean(),
 facts: evidenceFactsSchema,
 /** Restricted items exist but this viewer may not see them. */
 hiddenRestricted: z.number().int().nonnegative(),
 note: z.strictObject({ state: z.enum(['pending', 'succeeded', 'failed', 'uncertain']).nullable(), operationId: uuidSchema.nullable() }),
});
export type EvidenceSnapshot = z.infer<typeof evidenceSnapshotSchema>;
export const evidenceCaptureSchema = z.strictObject({ requestId: uuidSchema, previousId: uuidSchema.optional() });


// ── E3: pre-flight checks, verified receipts, issue subscriptions ──

/**
 * Action policies (plan 12 §7). Version-stamped and stored with each pre-flight. Only actions Resolve performs today;
 * account actions get policies when their executor exists. A low-impact action may proceed on "unknown"; an advisory
 * warning may be overridden with a reason; a block never can. Nothing overrides permissions.
 */
export const ACTION_POLICY_VERSION = 1;
export const ACTION_POLICIES = {
 'ticket.close': { label: 'Resolve this ticket?', verb: 'Resolve ticket', impact: 'low', overridable: true, refuseUnknown: false },
 'conversation.close': { label: 'Close this conversation?', verb: 'Close conversation', impact: 'low', overridable: true, refuseUnknown: false },
} as const;
export type PreflightAction = keyof typeof ACTION_POLICIES;
export const PREFLIGHT_TTL_SECONDS = 120;

export const preflightCheckSchema = z.strictObject({
 state: z.enum(['ok', 'warn', 'bad', 'unknown']),
 title: z.string(), detail: z.string(),
 sources: z.array(z.enum(['APM', 'SLO', 'ALERTS', 'SYNTHETICS', 'CASES'])),
});
export const preflightSchema = z.strictObject({
 id: uuidSchema,
 action: z.enum(Object.keys(ACTION_POLICIES) as [PreflightAction, ...PreflightAction[]]),
 appKey: appKeySchema, objectKind: z.enum(['ticket', 'conversation']), objectId: z.string(),
 impact: z.enum(['low', 'high']),
 outcome: z.enum(['allow', 'warn', 'block', 'unknown']),
 checks: z.array(preflightCheckSchema),
 conclusion: z.string().nullable(),
 /** The known issue to link instead, when the warning comes from one. */
 suggestedIssue: z.strictObject({ issueId: uuidSchema, title: z.string(), kind: z.enum(['alert', 'case']), providerId: z.string() }).nullable(),
 customer: z.strictObject({ externalId: z.string().nullable(), status: z.enum(SUBJECT_STATUS) }),
 overridable: z.boolean(),
 policyVersion: z.number().int(),
 evaluatedAt: isoDateTimeSchema, expiresAt: isoDateTimeSchema,
});
export type Preflight = z.infer<typeof preflightSchema>;
export const preflightRequestSchema = z.strictObject({ action: preflightSchema.shape.action });
/** Fields a gated action accepts alongside its own body. */
export const preflightUseSchema = {
 preflightId: uuidSchema.optional(),
 override: z.strictObject({ reason: z.string().trim().min(5).max(300) }).optional(),
};

export const RECEIPT_STAGE_STATES = ['ok', 'bad', 'wait', 'na'] as const;
export const receiptSchema = z.strictObject({
 operationId: uuidSchema,
 appKey: appKeySchema,
 operation: z.string(),
 /** "Delivered" only when downstream evidence was observed; "Sent" when the application accepted it and nothing more is known. */
 state: z.enum(['pending', 'accepted', 'observed', 'unverified', 'failed']),
 title: z.string(), subtitle: z.string(),
 stages: z.array(z.strictObject({ key: z.string(), title: z.string(), state: z.enum(RECEIPT_STAGE_STATES), source: z.string(), at: isoDateTimeSchema.nullable(), detail: z.string().nullable() })),
 facts: z.strictObject({ action: z.string(), target: z.string(), agent: z.string(), clearance: z.string().nullable(), ref: z.string() }),
 preflight: z.strictObject({ outcome: z.string(), overrideReason: z.string().nullable() }).nullable(),
});
export type Receipt = z.infer<typeof receiptSchema>;

export const liveActivitySchema = z.strictObject({
 entries: z.array(z.strictObject({
  at: isoDateTimeSchema, action: z.string(), appKey: appKeySchema, actor: z.string(), own: z.boolean(),
  /** Only for the person's own actions; others' targets are not disclosed. */
  operationId: uuidSchema.nullable(), target: z.string().nullable(),
  verification: z.enum(['verified', 'awaiting', 'unverified', 'none']),
 })),
});

export const issueSubscriptionSchema = z.strictObject({
 id: uuidSchema, issueId: uuidSchema, appKey: appKeySchema, title: z.string(), providerId: z.string(), kind: z.enum(['alert', 'case']),
 cleared: z.boolean(), objectKind: z.enum(['ticket', 'conversation']).nullable(), objectId: z.string().nullable(), createdAt: isoDateTimeSchema,
});
export const issueSubscriptionListSchema = z.strictObject({ subscriptions: z.array(issueSubscriptionSchema) });
export const subscribeRequestSchema = z.strictObject({ objectKind: z.enum(['ticket', 'conversation']).optional(), objectId: z.string().min(1).max(200).optional() });
