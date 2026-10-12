import { z } from 'zod';
import { appKeySchema, hostnameSchema, isoDateTimeSchema, sha256HexSchema, uuidSchema } from './common';
import { jobCheckSchema, JOB_COMMANDS, JOB_STAGES, TENANT_ROLES, type JobCommand } from './jobs';

/*
 * Phase 4 fleet administration (plan 07, plan 03, plan 02): application registration, the onboarding wizard,
 * privileged jobs, per-app team mappings and desired-state entitlements. Owner decisions 2026-10-12: one instance
 * per application/environment; create and adopt; chat, SSO and email required at activation; free-entry
 * hostnames under the approved support domains.
 */
export const ENVIRONMENTS = ['production', 'test'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
export const BINDING_LIFECYCLE = ['draft', 'onboarding', 'ready', 'active', 'suspended', 'retired'] as const;
export type BindingLifecycle = (typeof BINDING_LIFECYCLE)[number];
export const RUN_STATUSES = ['draft', 'reviewed', 'provisioning', 'validating', 'ready', 'activating', 'active', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const WIZARD_STEPS = ['describe', 'instance', 'access', 'entry', 'review', 'validate', 'activate'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

const text = (max: number) => z.string().trim().min(1, 'Required').max(max);
const teamKey = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'Team keys are lowercase letters, digits, hyphens and underscores');
const mailSlug = z.string().trim().regex(/^[a-z0-9-]{2,40}$/, 'Use 2–40 lowercase letters, digits or hyphens');

// ── Wizard steps (saved as drafts; validated again on review and on every dispatch) ──

export const describeStepSchema = z.strictObject({
 name: text(120),
 /** Stable key; becomes the workspace key for this environment. Never renamed. */
 key: appKeySchema,
 description: z.string().trim().max(500).default(''),
 appUrl: z.url({ protocol: /^https$/, error: 'Use the application’s https address' }),
 environment: z.enum(ENVIRONMENTS),
 ownerName: text(120),
 ownerEmail: z.email('Enter the owner’s email address'),
 supportTeam: text(120),
 contact: z.string().trim().max(200).default(''),
});
export const instanceStepSchema = z.discriminatedUnion('strategy', [
 z.strictObject({ strategy: z.literal('create'), supportHostname: hostnameSchema, mailSlug }),
 z.strictObject({ strategy: z.literal('adopt'), workspaceKey: appKeySchema, mailSlug }),
]);
export const teamMappingSchema = z.strictObject({ bundle: z.string().min(1).max(60), role: z.enum(['admin', 'agent', 'observer']), teams: z.array(teamKey).max(20) });
export const accessStepSchema = z.strictObject({
 teamMappings: z.array(teamMappingSchema).max(20),
 /** Resolve users who will run the pilot check before activation. */
 pilotUserIds: z.array(uuidSchema).min(1, 'Choose at least one pilot').max(10),
});
export const entryStepSchema = z.strictObject({
 emailAddress: z.email('Enter the inbound support address'),
 emailOwner: text(120),
 banner: z.boolean(),
});
export const STEP_SCHEMAS = { describe: describeStepSchema, instance: instanceStepSchema, access: accessStepSchema, entry: entryStepSchema } as const;
export type EditableStep = keyof typeof STEP_SCHEMAS;

/** PUT /api/admin/onboarding/:id/steps/:step. `version` is the run version the editor saw (optimistic concurrency). */
export const saveStepSchema = z.strictObject({ data: z.unknown(), version: z.number().int().nonnegative() });
/** POST /api/admin/onboarding — start a run with step 1. Optionally add an environment to an existing application. */
export const startOnboardingSchema = z.strictObject({ describe: describeStepSchema, applicationId: uuidSchema.optional() });
/** Dispatch requests carry the reviewed revision and a client request id, so a double submit is one job. */
export const dispatchSchema = z.strictObject({ configRevision: sha256HexSchema, requestId: uuidSchema });
export const activateSchema = dispatchSchema.extend({ validationJobId: uuidSchema });
export const lifecycleChangeSchema = z.strictObject({ requestId: uuidSchema, reason: z.enum(['operator', 'upgrade_hold', 'security']).optional() });
export const mappingsChangeSchema = z.strictObject({ teamMappings: z.array(teamMappingSchema).max(20), version: z.number().int().nonnegative() });

// ── Read models ──

export const jobViewSchema = z.strictObject({
 id: uuidSchema,
 requestId: uuidSchema,
 appKey: appKeySchema,
 command: z.enum(JOB_COMMANDS as [JobCommand, ...JobCommand[]]),
 stage: z.enum(JOB_STAGES),
 failureCode: z.string().nullable(),
 failedStage: z.enum(JOB_STAGES).nullable(),
 configRevision: sha256HexSchema.nullable(),
 checks: z.array(jobCheckSchema),
 testedImage: z.string().nullable(),
 initiator: z.string(),
 createdAt: isoDateTimeSchema,
 updatedAt: isoDateTimeSchema,
 /** False until the worker has accepted the job (a dispatch that did not reach it is retried with the same request id). */
 dispatched: z.boolean(),
});
export type JobView = z.infer<typeof jobViewSchema>;

export const pilotEvidenceSchema = z.strictObject({
 userId: uuidSchema, displayName: z.string(), configRevision: sha256HexSchema, at: isoDateTimeSchema,
 checks: z.array(jobCheckSchema),
 passed: z.boolean(),
});

/** Adoption impact report: what Resolve would manage, and what stays untouched. Read-only; nothing is changed. */
export const impactReportSchema = z.strictObject({
 workspaceKey: appKeySchema,
 displayName: z.string(),
 supportOrigin: z.url(),
 image: z.string(),
 state: z.string(),
 /** Hash of the report; provisioning with adopt names it, so a changed instance needs a fresh review. */
 revision: sha256HexSchema,
 data: z.strictObject({ conversations: z.number().int(), tickets: z.number().int(), people: z.number().int() }),
 /** Adoption never changes existing settings silently; `centralDefault` shows where the instance differs from policy. */
 settings: z.array(z.strictObject({ key: z.string(), label: z.string(), current: z.string(), afterAdoption: z.string(), centralDefault: z.string().nullable(), changes: z.boolean() })),
 /** Existing people. Only those who hold a mapped Resolve bundle become managed; everyone else is untouched. */
 people: z.array(z.strictObject({ name: z.string(), role: z.enum(TENANT_ROLES), managedAfter: z.boolean() })),
});
export type ImpactReport = z.infer<typeof impactReportSchema>;

export const onboardingRunSchema = z.strictObject({
 id: uuidSchema,
 applicationId: uuidSchema,
 applicationName: z.string(),
 environment: z.enum(ENVIRONMENTS),
 workspaceKey: appKeySchema.nullable(),
 status: z.enum(RUN_STATUSES),
 lifecycle: z.enum(BINDING_LIFECYCLE),
 version: z.number().int().nonnegative(),
 steps: z.strictObject({
  describe: describeStepSchema.nullable(), instance: instanceStepSchema.nullable(), access: accessStepSchema.nullable(), entry: entryStepSchema.nullable(),
 }),
 /** Set by review; cleared when any step changes, which also makes earlier validation stale. */
 configRevision: sha256HexSchema.nullable(),
 jobs: z.array(jobViewSchema),
 pilot: z.array(pilotEvidenceSchema),
 /** What blocks the next stage, in plain language. */
 blockers: z.array(z.string()),
 createdBy: z.string(),
 createdAt: isoDateTimeSchema,
 updatedAt: isoDateTimeSchema,
});
export type OnboardingRun = z.infer<typeof onboardingRunSchema>;

export const reviewSchema = z.strictObject({
 run: onboardingRunSchema,
 configRevision: sha256HexSchema,
 /** Who would get what in the tenant, per bundle; a bundle without a mapping gets nothing. */
 grants: z.array(z.strictObject({ bundle: z.string(), role: z.enum(TENANT_ROLES), teams: z.array(z.string()), people: z.number().int() })),
 unmappedBundles: z.array(z.string()),
 supportOrigin: z.string().nullable(),
 impact: impactReportSchema.nullable(),
 defaults: z.array(z.strictObject({ setting: z.string(), value: z.string(), source: z.string() })),
});
export type Review = z.infer<typeof reviewSchema>;

export const applicationSummarySchema = z.strictObject({
 id: uuidSchema,
 key: appKeySchema,
 name: z.string(),
 ownerName: z.string(),
 supportTeam: z.string(),
 bindings: z.array(z.strictObject({
  environment: z.enum(ENVIRONMENTS), workspaceKey: appKeySchema, lifecycle: z.enum(BINDING_LIFECYCLE), supportHostname: z.string().nullable(),
  strategy: z.enum(['create', 'adopt']), runId: uuidSchema.nullable(), runStatus: z.enum(RUN_STATUSES).nullable(),
 })),
 /** Runs that have not chosen an instance yet. */
 drafts: z.array(z.strictObject({ runId: uuidSchema, environment: z.enum(ENVIRONMENTS), status: z.enum(RUN_STATUSES) })),
});
export const applicationsResponseSchema = z.strictObject({
 applications: z.array(applicationSummarySchema),
 /** Registry apps with no Resolve binding (managed outside onboarding). */
 external: z.array(z.strictObject({ appKey: appKeySchema, displayName: z.string(), state: z.string() })),
});

export const unboundInstanceSchema = z.strictObject({ workspaceKey: appKeySchema, displayName: z.string(), supportOrigin: z.url(), image: z.string(), state: z.string() });
export const unboundResponseSchema = z.strictObject({ instances: z.array(unboundInstanceSchema) });

export const migrationStatusSchema = z.strictObject({
 workspaceKey: appKeySchema,
 state: z.string(),
 image: z.string(),
 targetImage: z.string(),
 appliedMigrations: z.number().int(),
 pendingMigrations: z.number().int(),
 receipts: z.strictObject({ upstream: z.string().nullable(), fork: z.string().nullable(), templates: z.string().nullable() }),
 /** The fleet's verdict: ready to serve the target image, or why not. */
 ready: z.boolean(),
 reason: z.string().nullable(),
});
export const migrationsResponseSchema = z.strictObject({ targetImage: z.string(), instances: z.array(migrationStatusSchema) });

export const appAdminSchema = z.strictObject({
 appKey: appKeySchema,
 applicationId: uuidSchema.nullable(),
 displayName: z.string(),
 lifecycle: z.enum(BINDING_LIFECYCLE).nullable(),
 registryState: z.string().nullable(),
 teamMappings: z.array(teamMappingSchema),
 mappingsVersion: z.number().int().nonnegative(),
 jobs: z.array(jobViewSchema),
 entitlements: z.strictObject({ users: z.number().int(), applied: z.number().int(), pending: z.number().int(), failed: z.number().int() }),
});
export type AppAdmin = z.infer<typeof appAdminSchema>;

/** POST/DELETE /api/admin/users/:id/bundles — manual bundle grants (claim bundles come from IdP groups). */
export const bundleGrantSchema = z.strictObject({ bundle: z.string().min(1).max(60), reason: z.string().trim().min(5).max(500) });
