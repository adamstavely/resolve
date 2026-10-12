import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrate } from '../../packages/database/src';
import { signIn } from '../../apps/api/lib/auth/repository';
import { startJob } from '../../apps/api/lib/fleet-admin/jobs';
import { claim, complete, recomputeUser, setMappings } from '../../apps/api/lib/fleet-admin/entitlements';

/*
 * Phase 4 persistence rules (plans 02 and 03): idempotent, per-app-locked privileged jobs with a monotonic
 * desired-state version, and desired-state entitlements whose jobs are leased and fenced.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for database tests');
const schema = 'fleet_' + randomUUID().replaceAll('-', '');
const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Pool({ connectionString: url, max: 1 });
const db = new Pool({ connectionString: scoped.toString(), max: 8 });

beforeAll(async () => {
 await admin.query(`CREATE SCHEMA ${schema}`);
 const dir = new URL('../../packages/database/migrations/', import.meta.url);
 const files = (await readdir(dir)).filter(f => /^\d{4}\.sql$/.test(f)).sort();
 await migrate(scoped.toString(), await Promise.all(files.map(async f => ({ version: f.slice(0, 4), sql: await readFile(new URL(f, dir), 'utf8') }))));
});
afterAll(async () => { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function person(bundles: string[]) {
 const r = await signIn(db, { issuer: 'https://idp.test', subject: 's-' + randomUUID(), displayName: 'P', email: null as unknown as string, bundles: bundles as never });
 if (r.status !== 'ok') throw new Error('sign-in failed');
 return r.userId;
}
const entitlement = async (userId: string, appKey: string) => (await db.query('SELECT desired_version, payload, last_applied_version FROM user_entitlements WHERE user_id = $1 AND app_key = $2', [userId, appKey])).rows[0];
const queued = async (userId: string, appKey: string) => (await db.query(`SELECT version, status FROM entitlement_jobs WHERE user_id = $1 AND app_key = $2 ORDER BY version`, [userId, appKey])).rows;

describe('privileged jobs', () => {
 test('a repeated request id is the same job; a different payload under it is refused', async () => {
  const actor = await person(['fleet-admin']);
  const appKey = 'app-' + randomUUID().slice(0, 8);
  const requestId = randomUUID();
  const a = await startJob(db, { appKey, command: 'suspend', parameters: { reason: 'operator' }, initiatorUserId: actor, requestId });
  const b = await startJob(db, { appKey, command: 'suspend', parameters: { reason: 'operator' }, initiatorUserId: actor, requestId });
  expect(a.kind).toBe('started');
  expect(b).toMatchObject({ kind: 'existing' });
  expect((b as { job: { id: string } }).job.id).toBe((a as { job: { id: string } }).job.id);
  expect(await startJob(db, { appKey, command: 'suspend', parameters: { reason: 'security' }, initiatorUserId: actor, requestId })).toEqual({ kind: 'conflict', code: 'REQUEST_CONFLICT' });
 });

 test('one running lifecycle job per app; the desired-state version only increases', async () => {
  const actor = await person(['fleet-admin']);
  const appKey = 'app-' + randomUUID().slice(0, 8);
  const first = await startJob(db, { appKey, command: 'suspend', parameters: { reason: 'operator' }, initiatorUserId: actor, requestId: randomUUID() });
  expect(await startJob(db, { appKey, command: 'resume', parameters: {}, initiatorUserId: actor, requestId: randomUUID() })).toEqual({ kind: 'conflict', code: 'APP_BUSY' });
  await db.query(`UPDATE fleet_jobs SET stage = 'succeeded' WHERE id = $1`, [(first as { job: { id: string } }).job.id]);
  const second = await startJob(db, { appKey, command: 'resume', parameters: {}, initiatorUserId: actor, requestId: randomUUID() });
  expect(Number((second as { job: { desired_state_version: string } }).job.desired_state_version)).toBeGreaterThan(Number((first as { job: { desired_state_version: string } }).job.desired_state_version));
 });

 test('concurrent submits of one request create one job', async () => {
  const actor = await person(['fleet-admin']);
  const appKey = 'app-' + randomUUID().slice(0, 8);
  const requestId = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => startJob(db, { appKey, command: 'suspend', parameters: { reason: 'operator' }, initiatorUserId: actor, requestId })));
  expect(new Set(results.map(r => (r as { job: { id: string } }).job.id)).size).toBe(1);
  expect(Number((await db.query('SELECT count(*) FROM fleet_jobs WHERE app_key = $1', [appKey])).rows[0].count)).toBe(1);
 });
});

describe('desired-state entitlements', () => {
 test('mapped bundles give one versioned entitlement; an unchanged result adds no version', async () => {
  const actor = await person(['fleet-admin']);
  const sam = await person(['fleet-agent']);
  const appKey = 'app-' + randomUUID().slice(0, 8);
  await setMappings(db, appKey, [{ bundle: 'fleet-agent', role: 'agent', teams: ['support'] }], null, actor);
  expect(await entitlement(sam, appKey)).toMatchObject({ desired_version: '1', payload: { status: 'active', role: 'agent', teams: ['support'] } });
  expect(await recomputeUser(db, sam)).toBe(0);
  expect(await queued(sam, appKey)).toEqual([{ version: '1', status: 'queued' }]);
 });

 test('a block becomes a denial with a newer version, and the older queued job is superseded', async () => {
  const actor = await person(['fleet-admin']);
  const bo = await person(['fleet-agent']);
  const appKey = 'app-' + randomUUID().slice(0, 8);
  await setMappings(db, appKey, [{ bundle: 'fleet-agent', role: 'agent', teams: ['billing'] }], null, actor);
  await db.query('UPDATE users SET enabled = false WHERE id = $1', [bo]);
  await recomputeUser(db, bo);
  expect(await entitlement(bo, appKey)).toMatchObject({ desired_version: '2', payload: { status: 'denied', role: 'portal', teams: [] } });
  expect(await queued(bo, appKey)).toEqual([{ version: '1', status: 'superseded' }, { version: '2', status: 'queued' }]);
 });

 test('removing a bundle demotes a managed person to portal instead of leaving their old role', async () => {
  const actor = await person(['fleet-admin']);
  const p = await person(['fleet-agent']);
  const appKey = 'app-' + randomUUID().slice(0, 8);
  await setMappings(db, appKey, [{ bundle: 'fleet-agent', role: 'agent', teams: ['support'] }], null, actor);
  await db.query(`DELETE FROM role_members WHERE user_id = $1`, [p]);
  await recomputeUser(db, p);
  expect((await entitlement(p, appKey)).payload).toEqual({ status: 'active', role: 'portal', teams: [] });
 });

 test('people never mapped stay unmanaged', async () => {
  const actor = await person(['fleet-admin']);
  const outsider = await person([]);
  const appKey = 'app-' + randomUUID().slice(0, 8);
  await setMappings(db, appKey, [{ bundle: 'fleet-agent', role: 'agent', teams: ['support'] }], null, actor);
  expect(await entitlement(outsider, appKey)).toBeUndefined();
 });

 test('mappings are version-checked', async () => {
  const actor = await person(['fleet-admin']);
  const appKey = 'app-' + randomUUID().slice(0, 8);
  expect(await setMappings(db, appKey, [], 0, actor)).toBe(true);
  expect(await setMappings(db, appKey, [], 0, actor)).toBe(false);
  expect(await setMappings(db, appKey, [], 1, actor)).toBe(true);
 });

 test('a reclaimed lease fences off the stalled worker', async () => {
  const actor = await person(['fleet-admin']);
  // A bundle no other test person holds, so this app's queue holds exactly one job.
  const p = await person(['announcement-author']);
  const appKey = 'fence-' + randomUUID().slice(0, 8);
  await db.query(`UPDATE entitlement_jobs SET status = 'superseded' WHERE status IN ('queued', 'leased')`);
  await setMappings(db, appKey, [{ bundle: 'announcement-author', role: 'agent', teams: ['support'] }], null, actor);
  const stalled = (await claim(db, 'worker-a'))!;
  expect(stalled).toMatchObject({ app_key: appKey, user_id: p });
  await db.query(`UPDATE entitlement_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [stalled.id]);
  const fresh = (await claim(db, 'worker-b'))!;
  expect(fresh.id).toBe(stalled.id);
  expect(Number(fresh.fencing_token)).toBeGreaterThan(Number(stalled.fencing_token));
  expect(await complete(db, stalled, { status: 'applied' })).toBe(false);
  expect(await complete(db, fresh, { status: 'applied' })).toBe(true);
  expect((await entitlement(p, appKey)).last_applied_version).toBe('1');
 });

 test('a late result for an older version never lowers what was applied', async () => {
  const actor = await person(['fleet-admin']);
  const p = await person(['announcement-author']);
  const appKey = 'late-' + randomUUID().slice(0, 8);
  await db.query(`UPDATE entitlement_jobs SET status = 'superseded' WHERE status IN ('queued', 'leased')`);
  await db.query(`DELETE FROM role_members WHERE bundle = 'announcement-author' AND user_id <> $1`, [p]); // only p holds it here
  await setMappings(db, appKey, [{ bundle: 'announcement-author', role: 'agent', teams: ['support'] }], null, actor);
  const v1 = (await claim(db, 'worker-a'))!;
  await setMappings(db, appKey, [{ bundle: 'announcement-author', role: 'observer', teams: ['support'] }], null, actor);
  const v2 = (await claim(db, 'worker-b'))!;
  expect([v1.version, v2.version]).toEqual(['1', '2']);
  expect(await complete(db, v2, { status: 'applied' })).toBe(true);
  expect(await complete(db, v1, { status: 'applied' })).toBe(true);
  expect((await entitlement(p, appKey)).last_applied_version).toBe('2');
 });
});
