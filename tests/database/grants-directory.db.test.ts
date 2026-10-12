import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrate } from '../../packages/database/src';
import { localSealer } from '../../apps/api/lib/crypto';
import { createSession, findSession, setUserEnabled, signIn } from '../../apps/api/lib/auth/repository';
import { applyDirectorySnapshot } from '../../apps/api/lib/directory';
import {
 accessToken, grantsFor, RefreshError, saveTenantClient, setGrantState, storeConnection, tenantClient, type RefreshResult,
} from '../../apps/api/lib/tenants/grants';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for database tests');
const schema = 'grants_' + randomUUID().replaceAll('-', '');
const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Pool({ connectionString: url, max: 1 });
const db = new Pool({ connectionString: scoped.toString(), max: 8 });
const sealer = localSealer(Buffer.alloc(32, 3).toString('base64'));
const ISS = 'https://idp.test';

beforeAll(async () => {
 await admin.query(`CREATE SCHEMA ${schema}`);
 const dir = new URL('../../packages/database/migrations/', import.meta.url);
 const files = (await readdir(dir)).filter(f => /^\d{4}\.sql$/.test(f)).sort();
 await migrate(scoped.toString(), await Promise.all(files.map(async f => ({ version: f.slice(0, 4), sql: await readFile(new URL(f, dir), 'utf8') }))));
});
afterAll(async () => { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function user(subject = 's-' + randomUUID()) {
 const r = await signIn(db, { issuer: ISS, subject, displayName: 'T', email: null, bundles: ['fleet-agent'] });
 if (r.status !== 'ok') throw new Error('expected ok');
 return { ...r, subject };
}
async function connect(u: { userId: string; identityId: string }, appKey = 'payroll', tenantUserId = 'tu-' + randomUUID(), expiresInMs = 300_000) {
 return storeConnection(db, sealer, { userId: u.userId, appKey, identityId: u.identityId, tenantIssuer: `https://${appKey}.test/api/auth`,
  tenantUserId, tenantPrincipalId: 'p-' + tenantUserId, scopes: ['read:chat'], accessToken: 'access-1', refreshToken: 'refresh-1', accessExpiresAt: new Date(Date.now() + expiresInMs) });
}

describe('tenant clients and grants', () => {
 test('client secrets and tokens are stored only sealed', async () => {
  await saveTenantClient(db, sealer, 'payroll', { clientId: 'resolve', clientSecret: 'client-secret-value' });
  expect(await tenantClient(db, sealer, 'payroll')).toEqual({ clientId: 'resolve', clientSecret: 'client-secret-value' });
  const u = await user(); await connect(u);
  const dump = JSON.stringify((await db.query('SELECT * FROM tenant_clients, user_tenant_grants WHERE user_tenant_grants.user_id = $1', [u.userId])).rows);
  for (const plain of ['client-secret-value', 'access-1', 'refresh-1']) expect(dump).not.toContain(plain);
 });

 test('one tenant account links to one Resolve user; the same human may connect two apps', async () => {
  const a = await user(), b = await user();
  expect(await connect(a, 'payroll', 'tenant-account-1')).toBe('stored');
  expect(await connect(b, 'payroll', 'tenant-account-1')).toBe('tenant_account_linked_elsewhere');
  expect(await connect(a, 'hr', 'tenant-account-hr')).toBe('stored');
  expect([...(await grantsFor(db, a.userId)).keys()].sort()).toEqual(['hr', 'payroll']);
  expect((await grantsFor(db, b.userId)).size).toBe(0);
 });

 test('reconnect with a different tenant account for an existing link is refused', async () => {
  const a = await user();
  await connect(a, 'payroll', 'first-account');
  expect(await connect(a, 'payroll', 'second-account')).toBe('tenant_account_linked_elsewhere');
 });

 test('leaving connected discards tokens (database constraint)', async () => {
  const a = await user(); await connect(a);
  await setGrantState(db, a.userId, 'payroll', 'not_connected');
  const row = (await db.query('SELECT access_token_enc, refresh_token_enc FROM user_tenant_grants WHERE user_id = $1', [a.userId])).rows[0];
  expect(row).toEqual({ access_token_enc: null, refresh_token_enc: null });
  await expect(db.query(`UPDATE user_tenant_grants SET state = 'revoked', access_token_enc = 'x' WHERE user_id = $1`, [a.userId])).rejects.toThrow();
 });
});

describe('access tokens and rotation', () => {
 const ok = (n: number): RefreshResult => ({ accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt: new Date(Date.now() + 300_000) });

 test('a fresh token is returned without refreshing', async () => {
  const a = await user(); await connect(a);
  let calls = 0;
  expect(await accessToken(db, sealer, a.userId, 'payroll', async () => { calls++; return ok(2); })).toMatchObject({ status: 'ok', accessToken: 'access-1' });
  expect(calls).toBe(0);
 });

 test('concurrent callers refresh once and share the rotated token', async () => {
  const a = await user(); await connect(a, 'payroll', undefined, 0);
  let calls = 0;
  const refresh = async (rt: string) => { calls++; expect(rt).toBe('refresh-1'); await new Promise(r => setTimeout(r, 50)); return ok(2); };
  const results = await Promise.all(Array.from({ length: 5 }, () => accessToken(db, sealer, a.userId, 'payroll', refresh)));
  expect(calls).toBe(1);
  expect(results.every(r => r.status === 'ok' && r.accessToken === 'access-2')).toBe(true);
 });

 test.each([
  ['refused refresh', new RefreshError('invalid_grant'), 'reconnect_required', 'refresh_rejected'],
  ['lost refresh response', new RefreshError('unknown'), 'reconnect_required', 'refresh_outcome_unknown'],
  ['unexpected error', new Error('boom'), 'reconnect_required', 'refresh_outcome_unknown'],
 ])('%s requires reconnect and discards tokens', async (_l, error, status, lastError) => {
  const a = await user(); await connect(a, 'payroll', undefined, 0);
  expect(await accessToken(db, sealer, a.userId, 'payroll', async () => { throw error; })).toEqual({ status });
  expect((await grantsFor(db, a.userId)).get('payroll')).toMatchObject({ state: 'reconnect_required', lastError });
 });

 test('a refresh that never reached the tenant keeps the grant', async () => {
  const a = await user(); await connect(a, 'payroll', undefined, 0);
  expect(await accessToken(db, sealer, a.userId, 'payroll', async () => { throw new RefreshError('not_sent'); })).toEqual({ status: 'unavailable' });
  expect((await grantsFor(db, a.userId)).get('payroll')?.state).toBe('connected');
 });
});

describe('directory observations', () => {
 const snapshot = (users: { sub: string; active: boolean; version: number }[], complete = false) => ({ observedAt: new Date().toISOString(), complete, users });

 test('disable revokes sessions and grants; a stale observation cannot re-enable; a newer one does, without restoring access', async () => {
  const a = await user(); await connect(a);
  const session = randomUUID();
  await createSession(db, { idHash: session, userId: a.userId, identityId: a.identityId, absoluteMinutes: 60 });

  expect(await applyDirectorySnapshot(db, ISS, 'test', snapshot([{ sub: a.subject, active: false, version: 10 }]))).toMatchObject({ applied: 1 });
  expect(await findSession(db, session, 60)).toBeUndefined();
  expect((await grantsFor(db, a.userId)).get('payroll')?.state).toBe('revoked');
  expect(await signIn(db, { issuer: ISS, subject: a.subject, displayName: 'T', email: null, bundles: [] })).toMatchObject({ status: 'disabled' });

  expect(await applyDirectorySnapshot(db, ISS, 'test', snapshot([{ sub: a.subject, active: true, version: 9 }]))).toMatchObject({ stale: 1 });
  expect((await db.query('SELECT enabled FROM users WHERE id = $1', [a.userId])).rows[0].enabled).toBe(false);

  expect(await applyDirectorySnapshot(db, ISS, 'test', snapshot([{ sub: a.subject, active: true, version: 11 }]))).toMatchObject({ applied: 1 });
  expect((await db.query('SELECT enabled FROM users WHERE id = $1', [a.userId])).rows[0].enabled).toBe(true);
  expect(await findSession(db, session, 60)).toBeUndefined();
  expect((await grantsFor(db, a.userId)).get('payroll')?.state).toBe('revoked');
 });

 test('replaying the same version is a no-op', async () => {
  const a = await user();
  await applyDirectorySnapshot(db, ISS, 'test', snapshot([{ sub: a.subject, active: true, version: 5 }]));
  expect(await applyDirectorySnapshot(db, ISS, 'test', snapshot([{ sub: a.subject, active: true, version: 5 }]))).toMatchObject({ unchanged: 1, applied: 0 });
 });

 test('a manual (emergency) denial is not lifted by the directory', async () => {
  const a = await user();
  await setUserEnabled(db, a.userId, false);
  await applyDirectorySnapshot(db, ISS, 'test', snapshot([{ sub: a.subject, active: true, version: 50 }]));
  expect((await db.query('SELECT enabled, disabled_reason FROM users WHERE id = $1', [a.userId])).rows[0]).toEqual({ enabled: false, disabled_reason: 'manual' });
 });

 test('absence from a complete snapshot disables; a partial snapshot proves nothing; unknown users are recorded only', async () => {
  const a = await user(), b = await user();
  await applyDirectorySnapshot(db, ISS, 'test', snapshot([{ sub: b.subject, active: true, version: 1 }], false));
  expect((await db.query('SELECT enabled FROM users WHERE id = $1', [a.userId])).rows[0].enabled).toBe(true);
  // A complete snapshot that omits a: a is disabled. Other users created by earlier tests are absent too.
  const r = await applyDirectorySnapshot(db, ISS, 'test', snapshot([{ sub: b.subject, active: true, version: 1 }, { sub: 'never-signed-in', active: true, version: 1 }], true));
  expect(r.unknown_user).toBe(1);
  expect(r.absent).toBeGreaterThanOrEqual(1);
  expect((await db.query('SELECT enabled, disabled_reason FROM users WHERE id = $1', [a.userId])).rows[0]).toEqual({ enabled: false, disabled_reason: 'directory_absent' });
  expect((await db.query('SELECT enabled FROM users WHERE id = $1', [b.userId])).rows[0].enabled).toBe(true);
 });

 test('every observation is recorded with its outcome and disables are audited as system actions', async () => {
  const a = await user();
  await applyDirectorySnapshot(db, ISS, 'audit-test', snapshot([{ sub: a.subject, active: false, version: 3 }]));
  expect((await db.query(`SELECT outcome FROM directory_observations WHERE source = 'audit-test' AND subject = $1`, [a.subject])).rows).toEqual([{ outcome: 'applied' }]);
  const ev = (await db.query(`SELECT actor_user_id, summary FROM audit_events WHERE operation = 'user.directory_disable' AND summary->>'userId' = $1`, [a.userId])).rows[0];
  expect(ev.actor_user_id).toBeNull();
  expect(ev.summary).toMatchObject({ executor: 'directory-sync', source: 'audit-test', version: 3 });
 });
});
