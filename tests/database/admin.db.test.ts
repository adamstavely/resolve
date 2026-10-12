import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrate } from '../../packages/database/src';
import { auditPage, decodeCursor, findUsers, setManualAccess } from '../../apps/api/lib/admin';
import { createSession, findSession, signIn } from '../../apps/api/lib/auth/repository';
import { applyDirectorySnapshot } from '../../apps/api/lib/directory';
import { localSealer } from '../../apps/api/lib/crypto';
import { grantsFor, storeConnection } from '../../apps/api/lib/tenants/grants';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for database tests');
const schema = 'admin_' + randomUUID().replaceAll('-', '');
const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Pool({ connectionString: url, max: 1 });
const db = new Pool({ connectionString: scoped.toString(), max: 4 });

beforeAll(async () => {
 await admin.query(`CREATE SCHEMA ${schema}`);
 const dir = new URL('../../packages/database/migrations/', import.meta.url);
 const files = (await readdir(dir)).filter(f => /^\d{4}\.sql$/.test(f)).sort();
 await migrate(scoped.toString(), await Promise.all(files.map(async f => ({ version: f.slice(0, 4), sql: await readFile(new URL(f, dir), 'utf8') }))));
});
afterAll(async () => { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function person(name = 'P ' + randomUUID().slice(0, 8)) {
 const subject = 's-' + randomUUID();
 const r = await signIn(db, { issuer: 'https://idp.test', subject, displayName: name, email: `${subject}@example.test`, bundles: ['fleet-agent'] });
 if (r.status !== 'ok') throw new Error('expected ok');
 return { ...r, subject, name };
}

describe('emergency access blocks', () => {
 test('blocking revokes sessions and app grants at once, and is audited with the reason', async () => {
  const actor = await person(), target = await person();
  const session = randomUUID();
  await createSession(db, { idHash: session, userId: target.userId, identityId: target.identityId, absoluteMinutes: 60 });
  await storeConnection(db, localSealer(Buffer.alloc(32, 1).toString('base64')), { userId: target.userId, appKey: 'payroll', identityId: target.identityId,
   tenantIssuer: 'https://p/api/auth', tenantUserId: 'tu-' + target.userId, tenantPrincipalId: 'p', scopes: ['read:chat'], accessToken: 'a', refreshToken: 'r', accessExpiresAt: new Date(Date.now() + 60_000) });
  expect(await setManualAccess(db, actor.userId, target.userId, false, 'Suspected compromise')).toBe('changed');
  expect(await findSession(db, session, 60)).toBeUndefined();
  expect((await grantsFor(db, target.userId)).get('payroll')?.state).toBe('revoked');
  const ev = (await db.query(`SELECT actor_user_id, outcome, summary FROM audit_events WHERE operation = 'user.manual_disable' AND summary->>'targetUserId' = $1`, [target.userId])).rows;
  expect(ev).toEqual([{ actor_user_id: actor.userId, outcome: 'succeeded', summary: { targetUserId: target.userId, reason: 'Suspected compromise', result: 'changed' } }]);
  expect(await setManualAccess(db, actor.userId, target.userId, false, 'again')).toBe('unchanged');
 });

 test('lifting a manual block re-enables without restoring sessions or grants', async () => {
  const actor = await person(), target = await person();
  await setManualAccess(db, actor.userId, target.userId, false, 'Investigation');
  expect(await setManualAccess(db, actor.userId, target.userId, true, 'Cleared')).toBe('changed');
  expect((await db.query('SELECT enabled, disabled_reason FROM users WHERE id = $1', [target.userId])).rows[0]).toEqual({ enabled: true, disabled_reason: null });
 });

 test('admins cannot block themselves; unknown people are reported', async () => {
  const actor = await person();
  expect(await setManualAccess(db, actor.userId, actor.userId, false, 'Oops')).toBe('self');
  expect(await setManualAccess(db, actor.userId, randomUUID(), false, 'Nobody')).toBe('not_found');
 });

 test('a directory-disabled person cannot be re-enabled manually', async () => {
  const actor = await person(), target = await person();
  await applyDirectorySnapshot(db, 'https://idp.test', 'test', { observedAt: new Date().toISOString(), complete: false, users: [{ sub: target.subject, active: false, version: 2 }] });
  expect(await setManualAccess(db, actor.userId, target.userId, true, 'Please')).toBe('directory_disabled');
  expect((await db.query('SELECT enabled FROM users WHERE id = $1', [target.userId])).rows[0].enabled).toBe(false);
  expect((await db.query(`SELECT outcome FROM audit_events WHERE operation = 'user.manual_enable' AND summary->>'targetUserId' = $1`, [target.userId])).rows).toEqual([{ outcome: 'denied' }]);
 });

 test('people search matches name and email, treating wildcards literally', async () => {
  const p = await person('Zed Searchable');
  expect((await findUsers(db, 'Searchable')).map(u => u.id)).toContain(p.userId);
  expect((await findUsers(db, p.subject.slice(0, 12))).map(u => u.id)).toEqual([p.userId]);
  expect(await findUsers(db, '%_%')).toEqual([]);
 });
});

describe('audit paging', () => {
 test('keyset paging neither loses nor repeats events with identical timestamps; filters apply', async () => {
  const at = '2020-01-01T00:00:00.123456Z';
  for (let i = 0; i < 7; i++) await db.query(`INSERT INTO audit_events (operation_id, at, operation, outcome, summary) VALUES (gen_random_uuid(), $1, 'grant.connect', 'failed', '{}')`, [at]);
  await db.query(`INSERT INTO audit_events (operation_id, at, operation, outcome, summary) VALUES (gen_random_uuid(), '2020-01-01T00:00:00.123457Z', 'grant.connect', 'failed', '{}')`);
  const seen: string[] = [];
  let before: [string, string] | undefined;
  for (;;) {
   const page = await auditPage(db, { category: 'grant', outcome: 'failed', limit: 3, before });
   seen.push(...page.events.map(e => e.id));
   if (!page.nextCursor) break;
   before = decodeCursor(page.nextCursor);
  }
  expect(seen).toHaveLength(8);
  expect(new Set(seen).size).toBe(8);
  expect((await auditPage(db, { category: 'session', limit: 50 })).events.every(e => e.operation.startsWith('session.'))).toBe(true);
 });

 test('malformed cursors are rejected', () => {
  for (const c of ['', 'garbage', Buffer.from('["x","y"]').toString('base64url'), Buffer.from('{}').toString('base64url')]) expect(decodeCursor(c)).toBeUndefined();
 });
});
