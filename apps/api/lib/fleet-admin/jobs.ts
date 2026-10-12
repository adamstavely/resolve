import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalJson, isSettledStage, type JobCommand, type JobRequest, type JobStage, type JobView } from '@resolve/contracts';
import { transaction, type Queryable } from '../db';
import { writeAudit } from '../audit';
import { resetRegistryCache } from '../registry';
import { cancelJob, getJob, resumeJob, submitJob } from './worker-client';

/*
 * Privileged job orchestration (contract 4, plan 03). Resolve records the intent first, then dispatches it to the fleet
 * worker. A request id makes a repeated submit (refresh, double click, a lost response) the same job, both here and
 * in the worker. One lifecycle job may run per app at a time (database lock, and the worker's own lock). Every stage
 * change is audited. A failed job resumes from its failed stage with exactly the same parameters, so retrying never
 * broadens what was approved.
 */
type LifecycleCommand = Exclude<JobCommand, 'apply_entitlements'>;
export interface JobRow {
 id: string; request_id: string; app_key: string; command: LifecycleCommand; parameters: Record<string, unknown>; payload_hash: string;
 desired_state_version: string; config_revision: string | null; run_id: string | null; initiator_user_id: string; operation_id: string;
 worker_job_id: string | null; dispatched_at: Date | null; stage: JobStage; failure_code: string | null; failed_stage: JobStage | null; checks: JobView['checks'];
 evidence: { configRevision: string; testedImage: string } | null; resources: { supportOrigin: string | null; workspaceKey: string } | null;
 created_at: Date; updated_at: Date;
}
export type StartResult = { kind: 'started' | 'existing'; job: JobRow } | { kind: 'conflict'; code: 'APP_BUSY' | 'REQUEST_CONFLICT' };

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const audit = (db: Queryable, job: JobRow, outcome: 'pending' | 'succeeded' | 'failed' | 'uncertain', extra: Record<string, string | number | boolean | null> = {}, actor = job.initiator_user_id) =>
 writeAudit(db, { actorUserId: actor, operationId: job.operation_id, operation: `app.job.${job.command}`, outcome,
  summary: { app: job.app_key, jobId: job.id, stage: job.stage, ...(job.failure_code ? { code: job.failure_code } : {}), ...extra } });

export async function startJob(db: Pick<Pool, 'connect'> & Queryable, input: {
 appKey: string; command: LifecycleCommand; parameters: Record<string, unknown>; runId?: string | null; initiatorUserId: string; requestId: string; configRevision?: string | null;
}): Promise<StartResult> {
 const payloadHash = hash({ appKey: input.appKey, command: input.command, parameters: input.parameters });
 try {
  return await transaction(db, async tx => {
   const prior = (await tx.query('SELECT * FROM fleet_jobs WHERE request_id = $1', [input.requestId])).rows[0] as JobRow | undefined;
   if (prior) return prior.payload_hash === payloadHash ? { kind: 'existing', job: prior } : { kind: 'conflict', code: 'REQUEST_CONFLICT' };
   const version = (await tx.query(`INSERT INTO app_state_versions (app_key, version) VALUES ($1, 1)
    ON CONFLICT (app_key) DO UPDATE SET version = app_state_versions.version + 1 RETURNING version`, [input.appKey])).rows[0].version;
   const job = (await tx.query(
    `INSERT INTO fleet_jobs (id, request_id, app_key, command, parameters, payload_hash, desired_state_version, config_revision, run_id, initiator_user_id, operation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [randomUUID(), input.requestId, input.appKey, input.command, JSON.stringify(input.parameters), payloadHash, version, input.configRevision ?? null,
     input.runId ?? null, input.initiatorUserId, randomUUID()])).rows[0] as JobRow;
   await audit(tx, job, 'pending', { configRevision: input.configRevision ?? null });
   return { kind: 'started', job };
  });
 } catch (e) {
  const constraint = (e as { constraint?: string }).constraint;
  if (constraint === 'fleet_jobs_running') {
   // A concurrent submit of this same request may hold the lock: that is the same job, not a conflict.
   const same = (await (db as unknown as Queryable).query('SELECT * FROM fleet_jobs WHERE request_id = $1', [input.requestId])).rows[0] as JobRow | undefined;
   if (same) return same.payload_hash === payloadHash ? { kind: 'existing', job: same } : { kind: 'conflict', code: 'REQUEST_CONFLICT' };
   return { kind: 'conflict', code: 'APP_BUSY' };
  }
  if (constraint === 'fleet_jobs_request_id_key') {
   const same = (await (db as unknown as Queryable).query('SELECT * FROM fleet_jobs WHERE request_id = $1', [input.requestId])).rows[0] as JobRow;
   return same.payload_hash === payloadHash ? { kind: 'existing', job: same } : { kind: 'conflict', code: 'REQUEST_CONFLICT' };
  }
  throw e;
 }
}

/** Send a recorded job to the worker. Safe to repeat: the worker dedupes on the request id. */
export async function dispatch(db: Pick<Pool, 'connect'> & Queryable, job: JobRow): Promise<JobRow> {
 const request = {
  appKey: job.app_key, requestId: job.request_id, desiredStateVersion: Number(job.desired_state_version),
  initiator: { userId: job.initiator_user_id, operationId: job.operation_id }, command: job.command, parameters: job.parameters,
 } as JobRequest;
 const o = await submitJob(request);
 if (o.kind === 'not_sent' || o.kind === 'unknown') return job; // retried by the dispatcher with the same request id
 return transaction(db, async tx => {
  const row = (await tx.query('SELECT * FROM fleet_jobs WHERE id = $1 FOR UPDATE', [job.id])).rows[0] as JobRow;
  if (o.kind === 'refused') return record(tx, row, { stage: 'cancelled', failure_code: o.code, worker_job_id: row.worker_job_id });
  return record(tx, row, { stage: o.data.stage, failure_code: o.data.failureCode, failed_stage: o.data.failedStage, worker_job_id: o.data.jobId, checks: o.data.checks, evidence: o.data.evidence, resources: o.data.resources });
 });
}

/** Apply a worker status to the row: audit the change and update the onboarding run and binding when it settles. */
async function record(tx: Queryable, row: JobRow, s: Partial<Pick<JobRow, 'stage' | 'failure_code' | 'failed_stage' | 'worker_job_id' | 'checks' | 'evidence' | 'resources'>>): Promise<JobRow> {
 const changed = s.stage !== row.stage || (s.failure_code ?? null) !== row.failure_code || JSON.stringify(s.checks ?? row.checks) !== JSON.stringify(row.checks);
 const updated = (await tx.query(
  `UPDATE fleet_jobs SET stage = $2, failure_code = $3, failed_stage = $8, worker_job_id = COALESCE($4, worker_job_id), dispatched_at = COALESCE(dispatched_at, CASE WHEN $4::uuid IS NOT NULL THEN now() END),
    checks = COALESCE($5, checks), evidence = COALESCE($6, evidence), resources = COALESCE($7, resources), updated_at = now() WHERE id = $1 RETURNING *`,
  [row.id, s.stage ?? row.stage, s.failure_code ?? null, s.worker_job_id ?? null, s.checks ? JSON.stringify(s.checks) : null,
   s.evidence ? JSON.stringify(s.evidence) : null, s.resources ? JSON.stringify(s.resources) : null, s.failed_stage ?? null])).rows[0] as JobRow;
 if (changed && updated.stage !== row.stage) {
  const settledOk = updated.stage === 'succeeded' || (updated.stage === 'ready_to_activate' && updated.command !== 'activate');
  const failed = ['retryable_failure', 'needs_operator', 'cancelled'].includes(updated.stage);
  await audit(tx, updated, settledOk ? 'succeeded' : failed ? 'failed' : 'pending', { from: row.stage });
  if (isSettledStage(updated.command, updated.stage)) await settle(tx, updated);
 }
 return updated;
}

/** What a settled job means for the binding's lifecycle and its onboarding run. */
async function settle(tx: Queryable, job: JobRow) {
 const ok = job.stage === 'succeeded' || job.stage === 'ready_to_activate';
 const binding = (await tx.query('SELECT id FROM instance_bindings WHERE workspace_key = $1', [job.app_key])).rows[0];
 const setBinding = (lifecycle: string, extra = '') => binding && tx.query(`UPDATE instance_bindings SET lifecycle = $2, updated_at = now()${extra} WHERE id = $1`, [binding.id, lifecycle]);
 const setRun = (status: string) => job.run_id && tx.query(`UPDATE onboarding_runs SET status = $2, updated_at = now() WHERE id = $1 AND status NOT IN ('active', 'cancelled')`, [job.run_id, status]);
 switch (job.command) {
  case 'provision': case 'validate':
   await setRun(ok ? 'ready' : 'failed');
   await setBinding(ok ? 'ready' : 'onboarding');
   break;
  case 'activate':
   await setRun(ok ? 'active' : 'failed');
   if (ok) { await tx.query(`UPDATE instance_bindings SET lifecycle = 'active', active_revision = $2, updated_at = now() WHERE workspace_key = $1`, [job.app_key, job.config_revision]); resetRegistryCache(); }
   break;
  case 'suspend': if (ok) { await setBinding('suspended'); resetRegistryCache(); } break;
  case 'resume': if (ok) { await setBinding('active'); resetRegistryCache(); } break;
 }
}

/** Bring a job up to date: dispatch it if it never reached the worker, else read its status. */
export async function refresh(db: Pick<Pool, 'connect'> & Queryable, id: string): Promise<JobRow | undefined> {
 const row = (await db.query('SELECT * FROM fleet_jobs WHERE id = $1', [id])).rows[0] as JobRow | undefined;
 if (!row) return undefined;
 if (!row.worker_job_id) return row.stage === 'requested' ? dispatch(db, row) : row;
 if (isSettledStage(row.command, row.stage)) return row;
 const o = await getJob(row.worker_job_id);
 if (o.kind !== 'ok') return row;
 return transaction(db, async tx => {
  const locked = (await tx.query('SELECT * FROM fleet_jobs WHERE id = $1 FOR UPDATE', [id])).rows[0] as JobRow;
  return record(tx, locked, { stage: o.data.stage, failure_code: o.data.failureCode, failed_stage: o.data.failedStage, checks: o.data.checks, evidence: o.data.evidence, resources: o.data.resources });
 });
}

/** Jobs that still need attention (undispatched, or running at the worker). */
export async function openJobIds(db: Queryable) {
 return (await db.query(`SELECT id FROM fleet_jobs WHERE stage IN ('requested', 'preparing', 'migrating', 'reconciling', 'validating', 'activating')
  OR (stage = 'ready_to_activate' AND command = 'activate') ORDER BY created_at`)).rows.map(r => r.id as string);
}

/** Operator retry of a failed job from its failed stage. The parameters cannot change. */
export async function resume(db: Pick<Pool, 'connect'> & Queryable, id: string, actorUserId: string): Promise<JobRow | 'not_resumable' | 'not_found' | 'unavailable'> {
 const row = (await db.query('SELECT * FROM fleet_jobs WHERE id = $1', [id])).rows[0] as JobRow | undefined;
 if (!row) return 'not_found';
 if (!row.worker_job_id || !['retryable_failure', 'needs_operator'].includes(row.stage)) return 'not_resumable';
 const o = await resumeJob(row.worker_job_id);
 if (o.kind === 'refused') return 'not_resumable';
 if (o.kind !== 'ok') return 'unavailable';
 return transaction(db, async tx => {
  const locked = (await tx.query('SELECT * FROM fleet_jobs WHERE id = $1 FOR UPDATE', [id])).rows[0] as JobRow;
  await writeAudit(tx, { actorUserId, operationId: locked.operation_id, operation: `app.job.${locked.command}`, outcome: 'pending', summary: { app: locked.app_key, jobId: id, action: 'resume', from: locked.stage } });
  if (locked.run_id) await tx.query(`UPDATE onboarding_runs SET status = $2, updated_at = now() WHERE id = $1 AND status = 'failed'`,
   [locked.run_id, locked.command === 'activate' ? 'activating' : locked.command === 'validate' ? 'validating' : 'provisioning']);
  return (await tx.query(`UPDATE fleet_jobs SET stage = $2, failure_code = NULL, failed_stage = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [id, o.data.stage])).rows[0] as JobRow;
 });
}

export async function cancel(db: Pick<Pool, 'connect'> & Queryable, id: string, actorUserId: string): Promise<JobRow | 'not_cancellable' | 'not_found' | 'unavailable'> {
 const row = (await db.query('SELECT * FROM fleet_jobs WHERE id = $1', [id])).rows[0] as JobRow | undefined;
 if (!row) return 'not_found';
 if (row.worker_job_id) {
  const o = await cancelJob(row.worker_job_id);
  if (o.kind === 'refused') return 'not_cancellable';
  if (o.kind !== 'ok') return 'unavailable';
 }
 return transaction(db, async tx => {
  const locked = (await tx.query('SELECT * FROM fleet_jobs WHERE id = $1 FOR UPDATE', [id])).rows[0] as JobRow;
  await writeAudit(tx, { actorUserId, operationId: locked.operation_id, operation: `app.job.${locked.command}`, outcome: 'failed', summary: { app: locked.app_key, jobId: id, action: 'cancel', from: locked.stage } });
  return record(tx, locked, { stage: 'cancelled', failure_code: 'CANCELLED_BY_OPERATOR', failed_stage: locked.stage });
 });
}

export async function jobsFor(db: Queryable, where: { runId?: string; appKey?: string }, limit = 20): Promise<JobView[]> {
 const rows = (await db.query(
  `SELECT j.*, u.display_name FROM fleet_jobs j JOIN users u ON u.id = j.initiator_user_id
   WHERE ($1::uuid IS NULL OR j.run_id = $1) AND ($2::text IS NULL OR j.app_key = $2) ORDER BY j.created_at DESC LIMIT $3`,
  [where.runId ?? null, where.appKey ?? null, limit])).rows;
 return rows.map(toView);
}

export const toView = (r: JobRow & { display_name?: string }): JobView => ({
 id: r.id, requestId: r.request_id, appKey: r.app_key, command: r.command, stage: r.stage, failureCode: r.failure_code, failedStage: r.failed_stage ?? null,
 configRevision: r.config_revision, checks: r.checks ?? [], testedImage: r.evidence?.testedImage ?? null, initiator: r.display_name ?? 'Unknown',
 createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), dispatched: !!r.worker_job_id,
});
