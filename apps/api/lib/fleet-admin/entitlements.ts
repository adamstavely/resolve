import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalJson, type TenantRole } from '@resolve/contracts';
import { transaction, type Queryable } from '../db';
import { writeAudit } from '../audit';
import { getJob, resumeJob, submitJob } from './worker-client';
import { rawRegistryApp } from '../registry';

/*
 * Desired-state entitlements (plan 02). For each person and each app with team mappings, Resolve computes the tenant
 * role and teams their bundles map to (or a denial when they are disabled). A change increments that person/app's
 * desired version and enqueues one job. Workers claim jobs with a lease and a new fencing token, discard jobs that a
 * newer version has superseded, and the tenant refuses to let an older version replace a newer one. A stalled worker
 * whose lease was reclaimed cannot record its result over a newer one (fencing).
 *
 * Who is managed: people holding a mapped bundle, and anyone managed before (so removing a bundle demotes them to
 * portal rather than leaving an old staff role behind). Everyone else in the tenant is untouched.
 */
export interface Entitlement { status: 'active' | 'denied'; role: TenantRole; teams: string[] }
const RANK: Record<TenantRole, number> = { portal: 0, observer: 1, agent: 2, admin: 3 };
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
export const LEASE_SECONDS = 30;

/** Pure: the entitlement a person's bundles and enabled state give them in one app. */
export function desiredEntitlement(bundles: string[], enabled: boolean, mappings: { bundle: string; role: Exclude<TenantRole, 'portal'>; teams: string[] }[]): Entitlement {
 if (!enabled) return { status: 'denied', role: 'portal', teams: [] };
 const mine = mappings.filter(m => bundles.includes(m.bundle));
 const role = mine.reduce<TenantRole>((best, m) => RANK[m.role] > RANK[best] ? m.role : best, 'portal');
 return { status: 'active', role, teams: [...new Set(mine.flatMap(m => m.teams))].sort() };
}

/** Recompute one person in one app; enqueue a job when the result changed. Returns the new version, if any. */
async function recompute(tx: Queryable, userId: string, appKey: string): Promise<number | null> {
 const user = (await tx.query(`SELECT u.enabled, ARRAY(SELECT DISTINCT bundle FROM role_members m WHERE m.user_id = u.id) AS bundles FROM users u WHERE u.id = $1`, [userId])).rows[0];
 if (!user) return null;
 const mappings = (await tx.query('SELECT bundle, role, teams FROM app_team_mappings WHERE app_key = $1', [appKey])).rows;
 const current = (await tx.query('SELECT desired_version, payload_hash FROM user_entitlements WHERE user_id = $1 AND app_key = $2 FOR UPDATE', [userId, appKey])).rows[0];
 const holdsMapped = mappings.some(m => user.bundles.includes(m.bundle));
 if (!current && !holdsMapped) return null; // never managed here and nothing to manage
 const e = desiredEntitlement(user.bundles, user.enabled, mappings);
 const payloadHash = hash(e);
 if (current?.payload_hash === payloadHash) return null;
 const version = Number(current?.desired_version ?? 0) + 1;
 await tx.query(`INSERT INTO user_entitlements (user_id, app_key, desired_version, payload, payload_hash) VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (user_id, app_key) DO UPDATE SET desired_version = $3, payload = $4, payload_hash = $5, last_error = NULL, updated_at = now()`,
  [userId, appKey, version, JSON.stringify(e), payloadHash]);
 // Older queued jobs for this person/app are obsolete now.
 await tx.query(`UPDATE entitlement_jobs SET status = 'superseded', updated_at = now() WHERE user_id = $1 AND app_key = $2 AND status = 'queued'`, [userId, appKey]);
 // A concurrent recompute may have queued the same version and payload already.
 await tx.query('INSERT INTO entitlement_jobs (user_id, app_key, version, payload_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, app_key, version) DO NOTHING', [userId, appKey, version, payloadHash]);
 await writeAudit(tx, { actorUserId: null, operation: 'entitlement.desired', outcome: 'succeeded', summary: { executor: 'resolve', userId, app: appKey, version, status: e.status, role: e.role } });
 return version;
}

/** After a person's bundles or access changed (sign-in, block, directory): every app they are or could be managed in. */
export async function recomputeUser(db: Pick<Pool, 'connect'>, userId: string) {
 return transaction(db, async tx => {
  const apps = (await tx.query(`SELECT DISTINCT app_key FROM app_team_mappings UNION SELECT app_key FROM user_entitlements WHERE user_id = $1`, [userId])).rows;
  let changed = 0;
  for (const a of apps) if (await recompute(tx, userId, a.app_key) !== null) changed++;
  return changed;
 });
}

/** After an app's mappings changed: everyone who holds a bundle or was managed there. */
export async function recomputeApp(db: Pick<Pool, 'connect'>, appKey: string) {
 return transaction(db, async tx => {
  const users = (await tx.query(`SELECT DISTINCT user_id FROM role_members UNION SELECT user_id FROM user_entitlements WHERE app_key = $1`, [appKey])).rows;
  let changed = 0;
  for (const u of users) if (await recompute(tx, u.user_id, appKey) !== null) changed++;
  return changed;
 });
}

/** Replace an app's mappings (version-checked) and recompute everyone there. */
export async function setMappings(db: Pick<Pool, 'connect'>, appKey: string, mappings: { bundle: string; role: string; teams: string[] }[], expectedVersion: number | null, actorUserId: string) {
 const ok = await transaction(db, async tx => {
  const cur = (await tx.query(`INSERT INTO app_mapping_versions (app_key) VALUES ($1) ON CONFLICT (app_key) DO UPDATE SET app_key = EXCLUDED.app_key RETURNING version`, [appKey])).rows[0];
  await tx.query('SELECT 1 FROM app_mapping_versions WHERE app_key = $1 FOR UPDATE', [appKey]);
  if (expectedVersion !== null && Number(cur.version) !== expectedVersion) return false;
  await tx.query('DELETE FROM app_team_mappings WHERE app_key = $1', [appKey]);
  for (const m of mappings) await tx.query('INSERT INTO app_team_mappings (app_key, bundle, role, teams) VALUES ($1, $2, $3, $4)', [appKey, m.bundle, m.role, m.teams]);
  await tx.query('UPDATE app_mapping_versions SET version = version + 1, updated_by = $2, updated_at = now() WHERE app_key = $1', [appKey, actorUserId]);
  await writeAudit(tx, { actorUserId, operation: 'app.mappings', outcome: 'succeeded', summary: { app: appKey, mappings: mappings.map(m => `${m.bundle}:${m.role}:${m.teams.join('+')}`).join(' ') || 'none' } });
  return true;
 });
 if (ok) await recomputeApp(db, appKey);
 return ok;
}

export async function mappingsFor(db: Queryable, appKey: string) {
 const rows = (await db.query('SELECT bundle, role, teams FROM app_team_mappings WHERE app_key = $1 ORDER BY bundle', [appKey])).rows;
 const version = Number((await db.query('SELECT version FROM app_mapping_versions WHERE app_key = $1', [appKey])).rows[0]?.version ?? 0);
 return { mappings: rows as { bundle: string; role: 'admin' | 'agent' | 'observer'; teams: string[] }[], version };
}

export interface ClaimedJob { id: string; user_id: string; app_key: string; version: string; payload_hash: string; fencing_token: string; worker_job_id: string | null; attempts: number }

/** Claim the oldest ready job (or one whose lease expired) with a fresh fencing token. */
export async function claim(db: Queryable, owner: string): Promise<ClaimedJob | undefined> {
 return (await db.query(
  `UPDATE entitlement_jobs SET status = 'leased', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2),
    fencing_token = nextval('entitlement_fencing'), attempts = attempts + 1, updated_at = now()
   WHERE id = (SELECT id FROM entitlement_jobs WHERE (status = 'queued' AND not_before <= now()) OR (status = 'leased' AND lease_expires_at < now())
    ORDER BY not_before, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING id, user_id, app_key, version, payload_hash, fencing_token, worker_job_id, attempts`, [owner, LEASE_SECONDS])).rows[0];
}

/** Record an outcome only if this worker still holds the lease (fencing). Returns false when the result was fenced off. */
export async function complete(db: Pick<Pool, 'connect'>, job: ClaimedJob, outcome: { status: 'applied' | 'superseded' | 'failed' | 'queued'; error?: string; workerJobId?: string; retryInSeconds?: number }) {
 return transaction(db, async tx => {
  const r = await tx.query(
   `UPDATE entitlement_jobs SET status = $3, last_error = $4, worker_job_id = COALESCE($5, worker_job_id), lease_owner = NULL, lease_expires_at = NULL,
     not_before = now() + make_interval(secs => $6), updated_at = now()
    WHERE id = $1 AND fencing_token = $2 AND status = 'leased' RETURNING id`, [job.id, job.fencing_token, outcome.status, outcome.error ?? null, outcome.workerJobId ?? null, outcome.retryInSeconds ?? 0]);
  if (!r.rowCount) return false;
  if (outcome.status === 'applied') {
   // Older versions never move last_applied_version backwards.
   await tx.query(`UPDATE user_entitlements SET last_applied_version = GREATEST(last_applied_version, $3), last_applied_at = now(), last_error = NULL
    WHERE user_id = $1 AND app_key = $2`, [job.user_id, job.app_key, job.version]);
   await writeAudit(tx, { actorUserId: null, operation: 'entitlement.applied', outcome: 'succeeded', summary: { executor: 'fleet-worker', userId: job.user_id, app: job.app_key, version: Number(job.version) } });
  }
  if (outcome.status === 'failed') {
   await tx.query('UPDATE user_entitlements SET last_error = $3 WHERE user_id = $1 AND app_key = $2', [job.user_id, job.app_key, outcome.error ?? 'FAILED']);
   await writeAudit(tx, { actorUserId: null, operation: 'entitlement.applied', outcome: 'failed', summary: { executor: 'fleet-worker', userId: job.user_id, app: job.app_key, version: Number(job.version), code: outcome.error ?? 'FAILED' } });
  }
  return true;
 });
}

const MAX_ATTEMPTS = 20;
/** Exponential backoff for a job that cannot apply yet (0.5 s, 1 s, 2 s … capped at 60 s). */
const backoff = (attempts: number) => Math.min(60, 0.25 * 2 ** Math.max(1, attempts));

/**
 * Process one claimed job: drop it if a newer version exists, else send apply_entitlements (request id = job id,
 * so a resend after a lost response is the same worker job) and record the result under the fence.
 */
export async function processJob(db: Pick<Pool, 'connect'> & Queryable, job: ClaimedJob): Promise<string> {
 const latest = (await db.query(`SELECT e.desired_version, e.payload, e.payload_hash, (SELECT issuer FROM identities i WHERE i.user_id = e.user_id ORDER BY last_login_at DESC NULLS LAST LIMIT 1) AS issuer,
   (SELECT subject FROM identities i WHERE i.user_id = e.user_id ORDER BY last_login_at DESC NULLS LAST LIMIT 1) AS subject
  FROM user_entitlements e WHERE e.user_id = $1 AND e.app_key = $2`, [job.user_id, job.app_key])).rows[0];
 if (!latest || Number(latest.desired_version) > Number(job.version)) { await complete(db, job, { status: 'superseded' }); return 'superseded'; }
 // An app the fleet does not list (still being created, or gone) cannot take it yet: wait without a worker round trip.
 if (!(await rawRegistryApp(job.app_key).catch(() => undefined))) {
  const attempts = Number(job.attempts);
  // Short, fixed wait: a new instance appears in the registry within seconds of being created.
  await complete(db, job, attempts >= MAX_ATTEMPTS ? { status: 'failed', error: 'NOT_REGISTERED' } : { status: 'queued', retryInSeconds: 1 });
  return attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
 }
 let workerJobId = job.worker_job_id;
 if (!workerJobId) {
  const o = await submitJob({
   appKey: job.app_key, requestId: job.attempts > 1 ? randomUUID() : job.id, desiredStateVersion: Number(job.version), initiator: { userId: job.user_id, operationId: job.id },
   command: 'apply_entitlements',
   parameters: { userId: job.user_id, entitlementVersion: Number(job.version), payloadHash: job.payload_hash, identity: { issuer: latest.issuer, subject: latest.subject }, entitlement: latest.payload },
  });
  if (o.kind === 'refused') { await complete(db, job, { status: 'failed', error: o.code }); return 'failed'; }
  if (o.kind !== 'ok') { await complete(db, job, { status: 'queued', retryInSeconds: backoff(1) }); return 'retry'; }
  workerJobId = o.data.jobId;
 } else {
  // A retry of a job the worker already has: the same request id would only return it, so resume it instead.
  const cur = await getJob(workerJobId);
  if (cur.kind === 'ok' && cur.data.stage === 'retryable_failure') await resumeJob(workerJobId);
  if (cur.kind === 'refused') {
   // The worker no longer knows this job (e.g. it was replaced): submit again under a fresh request id.
   await db.query('UPDATE entitlement_jobs SET worker_job_id = NULL WHERE id = $1', [job.id]);
   await complete(db, job, { status: 'queued', retryInSeconds: 0 });
   return 'retry';
  }
 }
 // The worker applies asynchronously; wait briefly for it to settle.
 for (let i = 0; i < 20; i++) {
  const s = await getJob(workerJobId);
  if (s.kind === 'ok' && s.data.stage === 'succeeded') { await complete(db, job, { status: 'applied', workerJobId }); return 'applied'; }
  if (s.kind === 'ok' && (s.data.stage === 'needs_operator' || s.data.stage === 'cancelled')) { await complete(db, job, { status: 'failed', error: s.data.failureCode ?? 'FAILED', workerJobId }); return 'failed'; }
  if (s.kind === 'ok' && s.data.stage === 'retryable_failure') {
   // e.g. the instance does not exist yet: try again later with a fresh worker job (same version, same payload).
   const attempts = Number((await db.query('SELECT attempts FROM entitlement_jobs WHERE id = $1', [job.id])).rows[0]?.attempts ?? 0);
   await complete(db, job, attempts >= MAX_ATTEMPTS ? { status: 'failed', error: s.data.failureCode ?? 'RETRIES_EXHAUSTED', workerJobId } : { status: 'queued', workerJobId, retryInSeconds: backoff(attempts) });
   return 'retry';
  }
  await new Promise(r => setTimeout(r, 100));
 }
 await complete(db, job, { status: 'queued', workerJobId });
 return 'retry';
}

/** Re-queue a failed apply (operator retry) with the same version and payload. */
export async function retryFailed(db: Queryable, appKey: string) {
 // Same version, payload and worker job (resumed on the next claim): a retry never changes what is applied.
 return (await db.query(`UPDATE entitlement_jobs SET status = 'queued', attempts = 0, not_before = now(), updated_at = now() WHERE app_key = $1 AND status = 'failed' RETURNING id`, [appKey])).rowCount ?? 0;
}

export async function entitlementSummary(db: Queryable, appKey: string) {
 const r = (await db.query(`SELECT count(*)::int AS users, count(*) FILTER (WHERE last_applied_version = desired_version)::int AS applied,
  count(*) FILTER (WHERE last_applied_version < desired_version AND last_error IS NULL)::int AS pending,
  count(*) FILTER (WHERE last_error IS NOT NULL)::int AS failed FROM user_entitlements WHERE app_key = $1`, [appKey])).rows[0];
 return { users: r.users, applied: r.applied, pending: r.pending, failed: r.failed };
}

export const workerId = () => `resolve-${process.pid}-${randomUUID().slice(0, 8)}`;
