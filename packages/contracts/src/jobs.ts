import { z } from 'zod';
import { appKeySchema, failureCodeSchema, hostnameSchema, isoDateTimeSchema, sha256HexSchema, uuidSchema } from './common';

/*
 * Contract 4 (plan 01, plan 03): privileged worker commands. Allowlisted commands with validated
 * parameters only. Resolve sends no DSN, secret, image, role or environment override: every object
 * is strict, so such fields fail validation here and must be rejected again inside the worker.
 */

const configRevision = sha256HexSchema;
const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const commandParameters = z.discriminatedUnion('command', [
 z.strictObject({ command: z.literal('provision'), parameters: z.strictObject({ supportHostname: hostnameSchema, mailSlug: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(), configRevision }) }),
 z.strictObject({ command: z.literal('validate'), parameters: z.strictObject({ configRevision }) }),
 z.strictObject({ command: z.literal('activate'), parameters: z.strictObject({ configRevision, testedImage: imageDigest, validationJobId: uuidSchema }) }),
 z.strictObject({ command: z.literal('suspend'), parameters: z.strictObject({ reason: z.enum(['operator', 'upgrade_hold', 'security']) }) }),
 z.strictObject({ command: z.literal('resume'), parameters: z.strictObject({}) }),
 z.strictObject({ command: z.literal('apply_entitlements'), parameters: z.strictObject({ userId: uuidSchema, entitlementVersion: z.number().int().positive(), payloadHash: sha256HexSchema }) }),
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

export const jobStatusSchema = z.strictObject({
 jobId: uuidSchema,
 requestId: uuidSchema,
 appKey: appKeySchema,
 command: z.enum(JOB_COMMANDS as [JobCommand, ...JobCommand[]]),
 stage: z.enum(JOB_STAGES),
 desiredStateVersion: z.number().int().positive(),
 updatedAt: isoDateTimeSchema,
 failureCode: failureCodeSchema.nullable(),
});
export type JobStatus = z.infer<typeof jobStatusSchema>;

const forward: Record<JobStage, readonly JobStage[]> = {
 requested: ['preparing', 'cancelled'],
 preparing: ['migrating', 'retryable_failure', 'needs_operator', 'cancelled'],
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

/** Only these stages may route normal traffic; every failure stage stays non-routable. */
export const isRoutableStage = (stage: JobStage) => stage === 'succeeded';
export const canTransition = (from: JobStage, to: JobStage) => forward[from].includes(to);
