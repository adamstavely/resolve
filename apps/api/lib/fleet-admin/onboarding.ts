import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
 BUNDLES, canonicalJson, STEP_SCHEMAS, instanceConfigurationSchema,
 type EditableStep, type ImpactReport, type InstanceConfiguration, type OnboardingRun, type Review, type RunStatus,
} from '@resolve/contracts';
import { z } from 'zod';
import { config } from '../config';
import { transaction, type Queryable } from '../db';
import { writeAudit } from '../audit';
import { sealer } from '../sealer';
import { saveTenantClient, tenantClient } from '../tenants/grants';
import { forgetTenantOidc } from '../tenants/oauth';
import { connectRedirectUri } from '../tenants/oauth';
import { resetRegistryCache } from '../registry';
import { setMappings } from './entitlements';
import { dispatch, jobsFor, startJob, type JobRow, type StartResult } from './jobs';
import { impactReport, unboundInstances, workerReportSchema } from './worker-client';

/*
 * Onboarding runs (plan 07). Steps are saved as drafts and validated again on review and on every dispatch.
 * Review fixes a configuration revision; any later edit clears it, and with it any validation evidence, so a
 * changed configuration can never be activated on old evidence. Activation needs: validation evidence for the
 * current revision and image (from the worker), and a passed pilot check by a real person for the same revision.
 */
type Steps = { describe?: z.infer<typeof STEP_SCHEMAS.describe>; instance?: z.infer<typeof STEP_SCHEMAS.instance>; access?: z.infer<typeof STEP_SCHEMAS.access>; entry?: z.infer<typeof STEP_SCHEMAS.entry> };
interface RunRow {
 id: string; application_id: string; environment: 'production' | 'test'; binding_id: string | null; status: RunStatus; steps: Steps; config: InstanceConfiguration | null;
 config_revision: string | null; report_revision: string | null; version: number; created_by: string; created_at: Date; updated_at: Date;
}
export class OnboardingError extends Error { constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, string> = {}) { super(message); } }
const fail = (status: number, code: string, message: string, details: Record<string, string> = {}): never => { throw new OnboardingError(status, code, message, details); };
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : canonicalJson(v)).digest('hex');
/** Steps that cannot change once an instance has been created or adopted. */
const LOCKED_AFTER_PROVISION: EditableStep[] = ['describe', 'instance'];

const workspaceKeyFor = (key: string, env: 'production' | 'test') => env === 'production' ? key : `${key}-test`;
export const underApprovedDomain = (hostname: string) => config().SUPPORT_DOMAINS.some(d => hostname.endsWith('.' + d));

async function loadRun(db: Queryable, id: string, lock = false): Promise<RunRow> {
 const row = (await db.query(`SELECT * FROM onboarding_runs WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0] as RunRow | undefined;
 return row ?? fail(404, 'NOT_FOUND', 'This onboarding run does not exist.');
}
async function provisioned(db: Queryable, runId: string) {
 return (await db.query(`SELECT 1 FROM fleet_jobs WHERE run_id = $1 AND command = 'provision' AND worker_job_id IS NOT NULL LIMIT 1`, [runId])).rowCount! > 0;
}
const audit = (db: Queryable, actorUserId: string, operation: string, summary: Record<string, string | number | boolean | null>, outcome: 'succeeded' | 'failed' | 'denied' = 'succeeded') =>
 writeAudit(db, { actorUserId, operation: `app.onboarding.${operation}`, outcome, summary });

// ── Start and steps ──

/** Start a run with step 1. Duplicates are refused with the existing record, rather than creating another. */
export async function startRun(db: Pick<Pool, 'connect'>, actorUserId: string, describe: Steps['describe'] & object, applicationId?: string) {
 return transaction(db, async tx => {
  const byKey = (await tx.query('SELECT id FROM applications WHERE key = $1', [describe.key])).rows[0];
  const byUrl = (await tx.query('SELECT id FROM applications WHERE lower(app_url) = lower($1)', [describe.appUrl])).rows[0];
  if (applicationId) {
   if (byKey && byKey.id !== applicationId) fail(409, 'APP_KEY_TAKEN', 'Another application already uses this key.', { applicationId: byKey.id });
  } else {
   if (byKey) fail(409, 'APP_EXISTS', 'An application with this key is already registered. Add an environment to it instead.', { applicationId: byKey.id });
   if (byUrl) fail(409, 'APP_EXISTS', 'An application with this address is already registered. Add an environment to it instead.', { applicationId: byUrl.id });
  }
  let appId = applicationId;
  if (appId) {
   if (!(await tx.query('SELECT 1 FROM applications WHERE id = $1', [appId])).rowCount) fail(404, 'NOT_FOUND', 'Application not found.');
  } else {
   appId = (await tx.query(`INSERT INTO applications (key, name, description, app_url, owner_name, owner_email, support_team, contact, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [describe.key, describe.name, describe.description, describe.appUrl, describe.ownerName, describe.ownerEmail, describe.supportTeam, describe.contact, actorUserId])).rows[0].id;
  }
  const binding = (await tx.query('SELECT 1 FROM instance_bindings WHERE application_id = $1 AND environment = $2', [appId, describe.environment])).rowCount;
  if (binding) fail(409, 'BINDING_EXISTS', `This application already has a ${describe.environment} instance.`, { applicationId: appId! });
  const open = (await tx.query(`SELECT id FROM onboarding_runs WHERE application_id = $1 AND environment = $2 AND status NOT IN ('active', 'cancelled')`, [appId, describe.environment])).rows[0];
  if (open) fail(409, 'RUN_EXISTS', 'Onboarding for this environment is already in progress.', { runId: open.id });
  const run = (await tx.query(`INSERT INTO onboarding_runs (application_id, environment, steps, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
   [appId, describe.environment, JSON.stringify({ describe }), actorUserId])).rows[0];
  await audit(tx, actorUserId, 'start', { runId: run.id, application: describe.key, environment: describe.environment });
  return run.id as string;
 });
}

/** Save one step (version-checked). Clears the reviewed revision, so validation must be repeated for the change. */
export async function saveStep(db: Pick<Pool, 'connect'>, actorUserId: string, id: string, step: EditableStep, raw: unknown, version: number) {
 const parsed = STEP_SCHEMAS[step].safeParse(raw);
 if (!parsed.success) fail(400, 'INVALID_STEP', parsed.error.issues[0]?.message ?? 'Check this step.', { field: parsed.error.issues[0]?.path.join('.') ?? '' });
 const data = parsed.data!;
 const unbound = step === 'instance' && (data as Steps['instance'])!.strategy === 'adopt' ? await unboundInstances() : null;
 return transaction(db, async tx => {
  const run = await loadRun(tx, id, true);
  if (run.status === 'active' || run.status === 'cancelled') fail(409, 'RUN_CLOSED', 'This onboarding run is finished.');
  if (run.version !== version) fail(409, 'CONFLICT', 'Someone else changed this onboarding run. Reload it and try again.');
  if (['provisioning', 'validating', 'activating'].includes(run.status)) fail(409, 'RUN_BUSY', 'Wait for the running job to finish before changing the configuration.');
  if (LOCKED_AFTER_PROVISION.includes(step) && await provisioned(tx, id)) fail(409, 'STEP_LOCKED', 'The application and instance cannot change after provisioning. Start a new run instead.');
  const steps: Steps = { ...run.steps };
  if (step === 'describe') {
   const d = data as NonNullable<Steps['describe']>;
   if (d.environment !== run.environment) fail(400, 'INVALID_STEP', 'The environment is fixed for this run; start another run for another environment.', { field: 'environment' });
   const app = (await tx.query('SELECT key FROM applications WHERE id = $1', [run.application_id])).rows[0];
   const others = (await tx.query('SELECT 1 FROM instance_bindings WHERE application_id = $1', [run.application_id])).rowCount;
   if (d.key !== app.key && (others || (await tx.query('SELECT 1 FROM applications WHERE key = $1', [d.key])).rowCount)) fail(409, 'APP_KEY_TAKEN', 'This key cannot be used.', { field: 'key' });
   const urlClash = (await tx.query('SELECT 1 FROM applications WHERE lower(app_url) = lower($1) AND id <> $2', [d.appUrl, run.application_id])).rowCount;
   if (urlClash) fail(409, 'APP_EXISTS', 'Another application already uses this address.', { field: 'appUrl' });
   await tx.query(`UPDATE applications SET key = $2, name = $3, description = $4, app_url = $5, owner_name = $6, owner_email = $7, support_team = $8, contact = $9, updated_at = now() WHERE id = $1`,
    [run.application_id, d.key, d.name, d.description, d.appUrl, d.ownerName, d.ownerEmail, d.supportTeam, d.contact]);
   steps.describe = d;
  }
  if (step === 'instance') {
   const i = data as NonNullable<Steps['instance']>;
   const describe = steps.describe ?? fail(400, 'STEP_ORDER', 'Describe the application first.');
   let workspaceKey: string, hostname: string | null = null;
   if (i.strategy === 'create') {
    if (!underApprovedDomain(i.supportHostname)) fail(400, 'INVALID_STEP', `Support hostnames must be under ${config().SUPPORT_DOMAINS.join(' or ')}.`, { field: 'supportHostname' });
    workspaceKey = workspaceKeyFor(describe.key, run.environment);
    hostname = i.supportHostname;
   } else {
    if (unbound?.kind !== 'ok') return fail(503, 'WORKER_UNAVAILABLE', 'The fleet worker could not list instances. Try again shortly.');
    // Only instances the fleet reports as unbound can be adopted (never a pasted address or credential).
    if (!unbound.data.instances.some(x => x.workspaceKey === i.workspaceKey)) fail(400, 'INVALID_STEP', 'Choose one of the unbound managed instances.', { field: 'workspaceKey' });
    workspaceKey = i.workspaceKey;
   }
   const clash = (await tx.query(`SELECT 1 FROM instance_bindings WHERE (workspace_key = $1 OR ($2::text IS NOT NULL AND support_hostname = $2)) AND id IS DISTINCT FROM $3`,
    [workspaceKey, hostname, run.binding_id])).rowCount;
   if (clash) fail(409, 'BINDING_EXISTS', hostname ? 'This workspace or hostname already belongs to another application.' : 'This instance is already bound to another application.', { field: i.strategy === 'create' ? 'supportHostname' : 'workspaceKey' });
   if (run.binding_id) {
    await tx.query(`UPDATE instance_bindings SET workspace_key = $2, strategy = $3, support_hostname = $4, mail_slug = $5, updated_at = now() WHERE id = $1`,
     [run.binding_id, workspaceKey, i.strategy, hostname, i.mailSlug]);
   } else {
    const b = (await tx.query(`INSERT INTO instance_bindings (application_id, environment, workspace_key, strategy, support_hostname, mail_slug) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
     [run.application_id, run.environment, workspaceKey, i.strategy, hostname, i.mailSlug])).rows[0];
    await tx.query('UPDATE onboarding_runs SET binding_id = $2 WHERE id = $1', [id, b.id]);
   }
   steps.instance = i;
  }
  if (step === 'access') {
   const a = data as NonNullable<Steps['access']>;
   const unknown = a.teamMappings.find(m => !(m.bundle in BUNDLES));
   if (unknown) fail(400, 'INVALID_STEP', `Unknown role bundle ${unknown.bundle}.`, { field: 'teamMappings' });
   if (new Set(a.teamMappings.map(m => m.bundle)).size !== a.teamMappings.length) fail(400, 'INVALID_STEP', 'Map each bundle once.', { field: 'teamMappings' });
   const pilots = (await tx.query(`SELECT u.id, u.display_name, ARRAY(SELECT DISTINCT bundle FROM role_members m WHERE m.user_id = u.id) AS bundles FROM users u WHERE u.id = ANY($1) AND u.enabled`, [a.pilotUserIds])).rows;
   if (pilots.length !== new Set(a.pilotUserIds).size) fail(400, 'INVALID_STEP', 'Every pilot must be an enabled Resolve user.', { field: 'pilotUserIds' });
   // A pilot reads and writes as themselves, so the mappings must give them a staff role in this instance.
   const staff = new Set(a.teamMappings.filter(m => m.role === 'admin' || m.role === 'agent').map(m => m.bundle));
   const without = pilots.find(p => !p.bundles.some((b: string) => staff.has(b)));
   if (without) fail(400, 'INVALID_STEP', `${without.display_name} holds no bundle mapped to an agent or admin role here, so they could not run the pilot check.`, { field: 'pilotUserIds' });
   steps.access = a;
  }
  if (step === 'entry') steps.entry = data as Steps['entry'];
  const status: RunStatus = run.status === 'reviewed' ? 'draft' : run.status;
  await tx.query(`UPDATE onboarding_runs SET steps = $2, status = $3, config = NULL, config_revision = NULL, report_revision = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
   [id, JSON.stringify(steps), status]);
  await audit(tx, actorUserId, 'step', { runId: id, step, invalidated: run.config_revision !== null });
 });
}

// ── Review ──

async function pilotsFor(db: Queryable, userIds: string[]) {
 return (await db.query(`SELECT DISTINCT ON (u.id) u.id, i.issuer, i.subject FROM users u JOIN identities i ON i.user_id = u.id
  WHERE u.id = ANY($1) ORDER BY u.id, i.last_login_at DESC NULLS LAST`, [userIds])).rows as { id: string; issuer: string; subject: string }[];
}

/** Build the exact configuration that provisioning will send, and its revision. */
export async function review(db: Pick<Pool, 'connect'> & Queryable, actorUserId: string, id: string): Promise<Review> {
 const run = await loadRun(db, id);
 const { describe, instance, access, entry } = run.steps;
 if (!describe || !instance || !access || !entry) fail(400, 'INCOMPLETE', 'Complete every step before review.');
 const pilots = await pilotsFor(db, access!.pilotUserIds);
 const configuration = instanceConfigurationSchema.parse({
  displayName: run.environment === 'production' ? describe!.name : `${describe!.name} (test)`, environment: run.environment,
  teamMappings: access!.teamMappings,
  channels: { chat: true, email: { address: entry!.emailAddress, owner: entry!.emailOwner }, banner: entry!.banner },
  pilots: pilots.map(p => ({ issuer: p.issuer, subject: p.subject })),
 });
 let impact: ImpactReport | null = null;
 let reportRevision: string | null = null;
 if (instance!.strategy === 'adopt') {
  const r = await impactReport(instance!.workspaceKey);
  if (r.kind !== 'ok') fail(503, 'WORKER_UNAVAILABLE', 'The adoption report is unavailable. Try again shortly.');
  const data = (r as { data: z.infer<typeof workerReportSchema> }).data;
  const mappedBundles = new Set(access!.teamMappings.map(m => m.bundle));
  const managed = new Set((await db.query(`SELECT i.issuer || '|' || i.subject AS k FROM identities i JOIN role_members m ON m.user_id = i.user_id WHERE m.bundle = ANY($1)`, [[...mappedBundles]])).rows.map(x => x.k));
  impact = { ...data, people: data.people.map(p => ({ name: p.name, role: p.role, managedAfter: managed.has(`${p.identity.issuer}|${p.identity.subject}`) })) };
  reportRevision = data.revision;
 }
 const binding = (await db.query('SELECT workspace_key FROM instance_bindings WHERE id = $1', [run.binding_id])).rows[0];
 const revision = sha({ configuration, instance, workspaceKey: binding?.workspace_key, reportRevision });
 const grants = await Promise.all(access!.teamMappings.map(async m => ({ bundle: m.bundle, role: m.role, teams: m.teams,
  people: Number((await db.query('SELECT count(DISTINCT user_id)::int AS n FROM role_members WHERE bundle = $1', [m.bundle])).rows[0].n) })));
 await transaction(db, async tx => {
  const locked = await loadRun(tx, id, true);
  if (locked.version !== run.version) fail(409, 'CONFLICT', 'The run changed during review. Review again.');
  await tx.query(`UPDATE onboarding_runs SET config = $2, config_revision = $3, report_revision = $4, status = CASE WHEN status = 'draft' THEN 'reviewed' ELSE status END, updated_at = now() WHERE id = $1`,
   [id, JSON.stringify(configuration), revision, reportRevision]);
  await audit(tx, actorUserId, 'review', { runId: id, configRevision: revision });
 });
 return {
  run: await runView(db, id), configRevision: revision, grants,
  unmappedBundles: Object.keys(BUNDLES).filter(b => !access!.teamMappings.some(m => m.bundle === b)),
  supportOrigin: instance!.strategy === 'create' ? `https://${instance!.supportHostname}` : impact?.supportOrigin ?? null,
  impact,
  defaults: [
   { setting: 'Sign-in', value: 'Company SSO (OIDC/SAML)', source: 'Central policy' },
   { setting: 'Portal', value: 'Behind intranet SSO', source: 'Central policy' },
   { setting: 'Anonymous actions', value: 'Off', source: 'Central policy' },
   { setting: 'Widget', value: 'HMAC-signed', source: 'Central policy' },
   { setting: 'Announcements', value: 'Everyone (authenticated)', source: 'Owner decision 2026-10-12' },
   { setting: 'Required channels', value: 'Chat, SSO and inbound email', source: 'Owner decision 2026-10-12' },
  ],
 };
}

// ── Dispatch ──

function requireRevision(run: RunRow, configRevision: string) {
 if (!run.config_revision) fail(409, 'NOT_REVIEWED', 'Review the configuration first.');
 if (run.config_revision !== configRevision) fail(409, 'STALE_REVISION', 'The configuration changed after you reviewed it. Review it again.');
}
const jobConflict = (r: StartResult) => {
 if (r.kind === 'conflict') fail(409, r.code, r.code === 'APP_BUSY' ? 'Another job is running for this application. Wait for it to finish.' : 'This request was already used for a different action.');
 return r as { kind: 'started' | 'existing'; job: JobRow };
};

/** Resolve's OAuth client at the tenant: generated here, sealed, and only its hash leaves Resolve. */
async function oauthClientFor(db: Queryable, workspaceKey: string) {
 let c = await tenantClient(db, sealer(), workspaceKey);
 if (!c) {
  c = { clientId: `resolve-${workspaceKey}`, clientSecret: randomBytes(32).toString('base64url') };
  await saveTenantClient(db, sealer(), workspaceKey, c);
  forgetTenantOidc(workspaceKey);
 }
 return { clientId: c.clientId, secretSha256: sha(c.clientSecret), redirectUri: connectRedirectUri() };
}

export async function provision(db: Pick<Pool, 'connect'> & Queryable, actorUserId: string, id: string, body: { configRevision: string; requestId: string }) {
 const run = await loadRun(db, id);
 requireRevision(run, body.configRevision);
 if (!['reviewed', 'failed', 'ready', 'provisioning'].includes(run.status)) fail(409, 'INVALID_STATE', 'This run cannot be provisioned now.');
 const binding = (await db.query('SELECT * FROM instance_bindings WHERE id = $1', [run.binding_id])).rows[0];
 const instance = run.steps.instance!;
 const oauthClient = await oauthClientFor(db, binding.workspace_key);
 const parameters = instance.strategy === 'create'
  ? { strategy: 'create', supportHostname: instance.supportHostname, mailSlug: instance.mailSlug, configRevision: run.config_revision!, configuration: run.config!, oauthClient }
  : { strategy: 'adopt', mailSlug: instance.mailSlug, configRevision: run.config_revision!, configuration: run.config!, oauthClient, reportRevision: run.report_revision! };
 const { kind, job } = jobConflict(await startJob(db, { appKey: binding.workspace_key, command: 'provision', parameters, runId: id, initiatorUserId: actorUserId, requestId: body.requestId, configRevision: run.config_revision }));
 // Side effects belong to the request that created the job; a concurrent or repeated submit only redispatches.
 if (kind === 'started') {
  // Managed roles for this instance: the reviewed mappings. Entitlement jobs apply them once the instance exists.
  await setMappings(db, binding.workspace_key, run.config!.teamMappings, null, actorUserId);
  await db.query(`UPDATE onboarding_runs SET status = 'provisioning', updated_at = now() WHERE id = $1`, [id]);
  await db.query(`UPDATE instance_bindings SET lifecycle = 'onboarding', updated_at = now() WHERE id = $1 AND lifecycle IN ('draft', 'onboarding', 'ready')`, [binding.id]);
  resetRegistryCache();
 }
 return dispatch(db, job);
}

export async function validate(db: Pick<Pool, 'connect'> & Queryable, actorUserId: string, id: string, body: { configRevision: string; requestId: string }) {
 const run = await loadRun(db, id);
 requireRevision(run, body.configRevision);
 if (!(await provisioned(db, id))) fail(409, 'NOT_PROVISIONED', 'Provision the instance first.');
 if (!['ready', 'failed', 'validating'].includes(run.status)) fail(409, 'INVALID_STATE', 'This run cannot be validated now.');
 const binding = (await db.query('SELECT workspace_key FROM instance_bindings WHERE id = $1', [run.binding_id])).rows[0];
 const { kind, job } = jobConflict(await startJob(db, { appKey: binding.workspace_key, command: 'validate', parameters: { configRevision: run.config_revision! }, runId: id, initiatorUserId: actorUserId, requestId: body.requestId, configRevision: run.config_revision }));
 if (kind === 'started') await db.query(`UPDATE onboarding_runs SET status = 'validating', updated_at = now() WHERE id = $1`, [id]);
 return dispatch(db, job);
}

/** The newest job that produced validation evidence for this run (provision or validate). */
async function latestValidation(db: Queryable, runId: string) {
 return (await db.query(`SELECT * FROM fleet_jobs WHERE run_id = $1 AND command IN ('provision', 'validate') ORDER BY created_at DESC LIMIT 1`, [runId])).rows[0] as JobRow | undefined;
}

export async function activate(db: Pick<Pool, 'connect'> & Queryable, actorUserId: string, id: string, body: { configRevision: string; requestId: string; validationJobId: string }) {
 const run = await loadRun(db, id);
 requireRevision(run, body.configRevision);
 const v = await latestValidation(db, id);
 if (!v || v.id !== body.validationJobId || v.stage !== 'ready_to_activate' || v.evidence?.configRevision !== run.config_revision)
  fail(409, 'STALE_VALIDATION', 'Validate the current configuration before activating.');
 const pilot = (await db.query(`SELECT 1 FROM pilot_checks WHERE run_id = $1 AND config_revision = $2 AND passed`, [id, run.config_revision])).rowCount;
 if (!pilot) fail(409, 'PILOT_REQUIRED', 'A pilot must complete the pilot check for this configuration before activation.');
 const binding = (await db.query('SELECT workspace_key FROM instance_bindings WHERE id = $1', [run.binding_id])).rows[0];
 const { kind, job } = jobConflict(await startJob(db, { appKey: binding.workspace_key, command: 'activate', runId: id, initiatorUserId: actorUserId, requestId: body.requestId, configRevision: run.config_revision,
  parameters: { configRevision: run.config_revision!, testedImage: v!.evidence!.testedImage, validationJobId: v!.worker_job_id! } }));
 if (kind === 'started') await db.query(`UPDATE onboarding_runs SET status = 'activating', updated_at = now() WHERE id = $1`, [id]);
 return dispatch(db, job);
}

export async function cancelRun(db: Pick<Pool, 'connect'>, actorUserId: string, id: string) {
 return transaction(db, async tx => {
  const run = await loadRun(tx, id, true);
  if (run.status === 'active' || run.status === 'cancelled') fail(409, 'RUN_CLOSED', 'This onboarding run is finished.');
  if (['provisioning', 'validating', 'activating'].includes(run.status)) fail(409, 'RUN_BUSY', 'Cancel the running job first.');
  const created = await provisioned(tx, id);
  await tx.query(`UPDATE onboarding_runs SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
  // A draft binding is released; anything already provisioned is kept (retired, not deleted) and reported.
  if (run.binding_id) await tx.query(created ? `UPDATE instance_bindings SET lifecycle = 'retired', updated_at = now() WHERE id = $1` : 'DELETE FROM instance_bindings WHERE id = $1', [run.binding_id]);
  await audit(tx, actorUserId, 'cancel', { runId: id, retainedInstance: created });
 });
}

// ── Pilot evidence ──

/** Is this person a pilot for the app's current onboarding run (and may reach it while it is not open)? */
export async function pilotRun(db: Queryable, userId: string, appKey: string) {
 return (await db.query(`SELECT r.id, r.config_revision FROM onboarding_runs r JOIN instance_bindings b ON b.id = r.binding_id
  WHERE b.workspace_key = $1 AND r.status IN ('ready', 'validating', 'failed') AND r.steps->'access'->'pilotUserIds' ? $2::text LIMIT 1`, [appKey, userId])).rows[0] as { id: string; config_revision: string | null } | undefined;
}

export async function recordPilot(db: Queryable, runId: string, userId: string, configRevision: string, checks: { id: string; label: string; status: 'passed' | 'failed'; required: boolean; detail: string | null }[]) {
 const passed = checks.every(c => c.status === 'passed' || !c.required);
 await db.query('INSERT INTO pilot_checks (run_id, user_id, config_revision, checks, passed) VALUES ($1, $2, $3, $4, $5)', [runId, userId, configRevision, JSON.stringify(checks), passed]);
 await writeAudit(db, { actorUserId: userId, operation: 'app.onboarding.pilot', outcome: passed ? 'succeeded' : 'failed', summary: { runId, configRevision, checks: checks.map(c => `${c.id}:${c.status}`).join(' ') } });
 return passed;
}

// ── Read models ──

export async function runView(db: Queryable, id: string): Promise<OnboardingRun> {
 const r = (await db.query(`SELECT r.*, a.name AS app_name, u.display_name AS creator, b.workspace_key, b.lifecycle
  FROM onboarding_runs r JOIN applications a ON a.id = r.application_id JOIN users u ON u.id = r.created_by LEFT JOIN instance_bindings b ON b.id = r.binding_id WHERE r.id = $1`, [id])).rows[0];
 if (!r) fail(404, 'NOT_FOUND', 'This onboarding run does not exist.');
 const jobs = await jobsFor(db, { runId: id });
 const pilot = (await db.query(`SELECT p.*, u.display_name FROM pilot_checks p JOIN users u ON u.id = p.user_id WHERE p.run_id = $1 ORDER BY p.created_at DESC LIMIT 10`, [id])).rows
  .map(p => ({ userId: p.user_id, displayName: p.display_name, configRevision: p.config_revision, at: p.created_at.toISOString(), checks: p.checks, passed: p.passed }));
 const steps = { describe: r.steps.describe ?? null, instance: r.steps.instance ?? null, access: r.steps.access ?? null, entry: r.steps.entry ?? null };
 return {
  id: r.id, applicationId: r.application_id, applicationName: r.app_name, environment: r.environment, workspaceKey: r.workspace_key ?? null,
  status: r.status, lifecycle: r.lifecycle ?? 'draft', version: r.version, steps, configRevision: r.config_revision, jobs, pilot,
  blockers: blockers(r.status, steps, r.config_revision, jobs, pilot), createdBy: r.creator, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
 };
}

function blockers(status: RunStatus, steps: OnboardingRun['steps'], revision: string | null, jobs: OnboardingRun['jobs'], pilot: OnboardingRun['pilot']): string[] {
 if (status === 'active' || status === 'cancelled') return [];
 const out: string[] = [];
 for (const [k, label] of [['describe', 'Describe the application'], ['instance', 'Choose the support instance'], ['access', 'Configure support and access'], ['entry', 'Configure entry points']] as const)
  if (!steps[k]) out.push(`${label}.`);
 if (out.length) return out;
 if (steps.access && !steps.access.teamMappings.some(m => m.role !== 'observer' && (m.role === 'admin' || m.teams.length)))
  out.push('Map at least one bundle to an agent role with a team, or an admin role. Unmapped bundles get no access.');
 if (!revision) { out.push('Review the configuration.'); return out; }
 const validation = jobs.find(j => j.command === 'provision' || j.command === 'validate');
 if (!validation) { out.push('Provision the instance.'); return out; }
 if (validation.configRevision !== revision) out.push('The configuration changed after provisioning. Provision again to apply it, then validate.');
 else if (['retryable_failure', 'needs_operator'].includes(validation.stage)) out.push(`${validation.command === 'provision' ? 'Provisioning' : 'Validation'} stopped (${validation.failureCode}). Fix the cause, then resume or validate again.`);
 else if (validation.stage !== 'ready_to_activate') out.push('Wait for validation to finish.');
 else if (!pilot.some(p => p.passed && p.configRevision === revision)) out.push('A pilot must run the pilot check against this configuration.');
 return out;
}

export async function listApplications(db: Queryable) {
 const rows = (await db.query(`SELECT a.id, a.key, a.name, a.owner_name, a.support_team,
   COALESCE(json_agg(json_build_object('environment', b.environment, 'workspaceKey', b.workspace_key, 'lifecycle', b.lifecycle, 'supportHostname', b.support_hostname,
    'strategy', b.strategy, 'runId', (SELECT r.id FROM onboarding_runs r WHERE r.binding_id = b.id ORDER BY r.created_at DESC LIMIT 1),
    'runStatus', (SELECT r.status FROM onboarding_runs r WHERE r.binding_id = b.id ORDER BY r.created_at DESC LIMIT 1)) ORDER BY b.environment) FILTER (WHERE b.id IS NOT NULL), '[]') AS bindings
  FROM applications a LEFT JOIN instance_bindings b ON b.application_id = a.id GROUP BY a.id ORDER BY a.name`)).rows;
 const drafts = (await db.query(`SELECT r.id, r.application_id, r.environment, r.status FROM onboarding_runs r WHERE r.binding_id IS NULL AND r.status NOT IN ('cancelled')`)).rows;
 return rows.map(a => ({ id: a.id, key: a.key, name: a.name, ownerName: a.owner_name, supportTeam: a.support_team, bindings: a.bindings,
  drafts: drafts.filter(d => d.application_id === a.id).map(d => ({ runId: d.id, environment: d.environment, status: d.status })) }));
}

export const newRequestId = () => randomUUID();
