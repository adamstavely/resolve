import { z } from 'zod';
import { appKeySchema, failureCodeSchema, hostnameSchema, isoDateTimeSchema, sha256HexSchema, uuidSchema } from './common';

/*
 * Contract 4 (plan 01, plan 03): privileged worker commands. Allowlisted commands with validated
 * parameters only. Resolve sends no DSN, secret, image, role or environment override: every object
 * is strict, so such fields fail validation here and must be rejected again inside the worker.
 */

const configRevision = sha256HexSchema;
export const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Tenant roles a managed principal can be given (plan 02); `portal` means no staff role. */
export const TENANT_ROLES = ['admin', 'agent', 'observer', 'portal'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];
const teamKey = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);

/**
 * Reviewed instance configuration (plan 07 steps 3-4). Centrally managed defaults (company SSO, portal behind
 * intranet SSO, anonymous actions off, widget HMAC, Everyone-only announcements) are fixed, not choices.
 */
export const instanceConfigurationSchema = z.strictObject({
 displayName: z.string().min(1).max(120),
 environment: z.enum(['production', 'test']),
 /** Per-app mapping: a Resolve bundle → tenant role and teams. A bundle without a mapping grants nothing here. */
 teamMappings: z.array(z.strictObject({ bundle: z.string().min(1).max(60), role: z.enum(['admin', 'agent', 'observer']), teams: z.array(teamKey).max(20) })).max(20),
 channels: z.strictObject({
  chat: z.literal(true),
  /** Inbound support email; required at activation (owner decision 2026-10-12). */
  email: z.strictObject({ address: z.string().email().max(254), owner: z.string().min(1).max(120) }),
  banner: z.boolean(),
 }),
 /** Federated identities of the people who will run the pilot check while the instance is not routable. */
 pilots: z.array(z.strictObject({ issuer: z.string().url(), subject: z.string().min(1).max(255) })).min(1).max(10),
});
export type InstanceConfiguration = z.infer<typeof instanceConfigurationSchema>;

/**
 * Resolve's OAuth client at the tenant. Resolve generates the secret and keeps it sealed; the worker receives only
 * its SHA-256, so no secret travels in a job (contract 4).
 */
const oauthClient = z.strictObject({ clientId: z.string().regex(/^[A-Za-z0-9._-]{3,100}$/), secretSha256: sha256HexSchema, redirectUri: z.url() });

const commandParameters = z.discriminatedUnion('command', [
 z.strictObject({ command: z.literal('provision'), parameters: z.discriminatedUnion('strategy', [
  z.strictObject({ strategy: z.literal('create'), supportHostname: hostnameSchema, mailSlug: z.string().regex(/^[a-z0-9-]{2,40}$/), configRevision, configuration: instanceConfigurationSchema, oauthClient }),
  /** Adopt an existing unbound managed instance: no data, authentication or unmanaged roles change. */
  z.strictObject({ strategy: z.literal('adopt'), mailSlug: z.string().regex(/^[a-z0-9-]{2,40}$/), configRevision, configuration: instanceConfigurationSchema, oauthClient, reportRevision: sha256HexSchema }),
 ]) }),
 z.strictObject({ command: z.literal('validate'), parameters: z.strictObject({ configRevision }) }),
 z.strictObject({ command: z.literal('activate'), parameters: z.strictObject({ configRevision, testedImage: imageDigest, validationJobId: uuidSchema }) }),
 z.strictObject({ command: z.literal('suspend'), parameters: z.strictObject({ reason: z.enum(['operator', 'upgrade_hold', 'security']) }) }),
 z.strictObject({ command: z.literal('resume'), parameters: z.strictObject({}) }),
 z.strictObject({ command: z.literal('apply_entitlements'), parameters: z.strictObject({
  userId: uuidSchema, entitlementVersion: z.number().int().positive(), payloadHash: sha256HexSchema,
  /** The person's federated identity; tenant accounts are keyed by it, never by email. */
  identity: z.strictObject({ issuer: z.string().url(), subject: z.string().min(1).max(255) }),
  entitlement: z.strictObject({ status: z.enum(['active', 'denied']), role: z.enum(TENANT_ROLES), teams: z.array(teamKey).max(40) }),
 }) }),
]);
export type JobCommand = z.infer<typeof commandParameters>['command'];
export const JOB_COMMANDS: readonly JobCommand[] = ['provision', 'validate', 'activate', 'suspend', 'resume', 'apply_entitlements'];

const envelope = z.strictObject({
 appKey: appKeySchema,
 requestId: uuidSchema,
 /** Per-app monotonic desired-state version; older versions never replace newer ones (plan 02). */
 desiredStateVersion: z.number().int().positive(),
 initiator: z.strictObject({ userId: uuidSchema, operationId: uuidSchema }),
});

export const jobRequestSchema = z.intersection(envelope, commandParameters);
export type JobRequest = z.infer<typeof jobRequestSchema>;

/** Stages from plan 07; plan 03's create/resume machine is the requested → succeeded path. */
export const JOB_STAGES = ['requested', 'preparing', 'migrating', 'reconciling', 'validating', 'ready_to_activate', 'activating', 'succeeded', 'retryable_failure', 'needs_operator', 'cancelled'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export const CHECK_STATES = ['passed', 'failed', 'pending', 'skipped'] as const;
/** One validation check. `detail` is a short redacted explanation, never tenant data or secrets. */
export const jobCheckSchema = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/), label: z.string().max(120), status: z.enum(CHECK_STATES), required: z.boolean(), detail: z.string().max(200).nullable() });
export type JobCheck = z.infer<typeof jobCheckSchema>;

export const jobStatusSchema = z.strictObject({
 jobId: uuidSchema,
 requestId: uuidSchema,
 appKey: appKeySchema,
 command: z.enum(JOB_COMMANDS as [JobCommand, ...JobCommand[]]),
 stage: z.enum(JOB_STAGES),
 desiredStateVersion: z.number().int().positive(),
 updatedAt: isoDateTimeSchema,
 failureCode: failureCodeSchema.nullable(),
 /** The stage that failed (a resume continues from it); null unless the job is in a failure stage. */
 failedStage: z.enum(JOB_STAGES).nullable().default(null),
 /** Validation evidence, bound to the configuration revision and image it was run against. */
 checks: z.array(jobCheckSchema).max(60).default([]),
 evidence: z.strictObject({ configRevision: sha256HexSchema, testedImage: imageDigest }).nullable().default(null),
 /** Non-secret identities of what the job created or bound. */
 resources: z.strictObject({ supportOrigin: z.url().nullable(), workspaceKey: appKeySchema }).nullable().default(null),
});
export type JobStatus = z.infer<typeof jobStatusSchema>;

const forward: Record<JobStage, readonly JobStage[]> = {
 // validate starts at validating, activate at activating; other commands prepare first.
 requested: ['preparing', 'validating', 'activating', 'cancelled'],
 // suspend, resume and apply_entitlements finish after preparing (no migration or validation).
 preparing: ['migrating', 'succeeded', 'retryable_failure', 'needs_operator', 'cancelled'],
 migrating: ['reconciling', 'retryable_failure', 'needs_operator'],
 reconciling: ['validating', 'retryable_failure', 'needs_operator'],
 validating: ['ready_to_activate', 'retryable_failure', 'needs_operator'],
 // Configuration changed after validation: evidence is stale, validate again (plan 07 step 6).
 ready_to_activate: ['activating', 'validating', 'cancelled'],
 activating: ['succeeded', 'retryable_failure', 'needs_operator'],
 retryable_failure: ['preparing', 'migrating', 'reconciling', 'validating', 'activating', 'needs_operator', 'cancelled'],
 needs_operator: ['preparing', 'migrating', 'reconciling', 'validating', 'activating', 'cancelled'],
 succeeded: [],
 cancelled: [],
};

/** Happy path per command. Provision and validate end at ready_to_activate: only activate makes an instance routable. */
export const COMMAND_PATHS: Record<JobCommand, readonly JobStage[]> = {
 provision: ['requested', 'preparing', 'migrating', 'reconciling', 'validating', 'ready_to_activate'],
 validate: ['requested', 'validating', 'ready_to_activate'],
 activate: ['requested', 'activating', 'succeeded'],
 suspend: ['requested', 'preparing', 'succeeded'],
 resume: ['requested', 'preparing', 'succeeded'],
 apply_entitlements: ['requested', 'preparing', 'succeeded'],
};
/** Stages after which a job does nothing more on its own. ready_to_activate ends provision and validate jobs. */
export const isSettledStage = (command: JobCommand, stage: JobStage) =>
 stage === 'succeeded' || stage === 'cancelled' || stage === 'needs_operator' || stage === 'retryable_failure' || (stage === 'ready_to_activate' && command !== 'activate');

/** Only these stages may route normal traffic; every failure stage stays non-routable. */
export const isRoutableStage = (stage: JobStage) => stage === 'succeeded';
export const canTransition = (from: JobStage, to: JobStage) => forward[from].includes(to);
