import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrate } from '../../packages/database/src';
import {
 consumeLoginAttempt, createLoginAttempt, createSession, findSession, revokeSession, sessionStillValid, setUserEnabled, signIn, type SignInClaims,
} from '../../apps/api/lib/auth/repository';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for database tests');
const schema = 'auth_' + randomUUID().replaceAll('-', '');
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

const claims = (o: Partial<SignInClaims> = {}): SignInClaims => ({ issuer: 'https://idp.test', subject: 's-' + randomUUID(), displayName: 'Test', email: 'shared@example.test', bundles: ['fleet-agent'], ...o });
const ok = async (c: SignInClaims) => { const r = await signIn(db, c); if (r.status !== 'ok') throw new Error('expected ok'); return r; };

describe('identity mapping (plan 02: issuer/subject, never email)', () => {
 test('the same issuer/subject resolves to the same user and refreshes display data', async () => {
  const c = claims();
  const a = await ok(c);
  const b = await ok({ ...c, displayName: 'Renamed', email: 'new@example.test' });
  expect(b.userId).toBe(a.userId);
  expect((await db.query('SELECT display_name, email FROM users WHERE id = $1', [a.userId])).rows[0]).toEqual({ display_name: 'Renamed', email: 'new@example.test' });
 });

 test('same email with a different subject is a different user', async () => {
  const a = await ok(claims({ email: 'sam@example.test' }));
  const b = await ok(claims({ email: 'sam@example.test' }));
  expect(b.userId).not.toBe(a.userId);
 });

 test('same subject from a different issuer is a different user', async () => {
  const subject = 's-' + randomUUID();
  const a = await ok(claims({ subject }));
  const b = await ok(claims({ subject, issuer: 'https://other-idp.test' }));
  expect(b.userId).not.toBe(a.userId);
 });

 test('concurrent first sign-ins create one user', async () => {
  const c = claims();
  const results = await Promise.all(Array.from({ length: 6 }, () => ok(c)));
  expect(new Set(results.map(r => r.userId)).size).toBe(1);
  expect((await db.query('SELECT count(*)::int AS n FROM identities WHERE subject = $1', [c.subject])).rows[0].n).toBe(1);
 });

 test('claim bundles are replaced on each sign-in; manual grants are kept', async () => {
  const c = claims({ bundles: ['fleet-admin'] });
  const { userId } = await ok(c);
  await db.query(`INSERT INTO role_members (user_id, bundle, source) VALUES ($1, 'announcement-author', 'manual')`, [userId]);
  await ok({ ...c, bundles: ['fleet-observer'] });
  const rows = (await db.query('SELECT bundle, source FROM role_members WHERE user_id = $1 ORDER BY bundle', [userId])).rows;
  expect(rows).toEqual([{ bundle: 'announcement-author', source: 'manual' }, { bundle: 'fleet-observer', source: 'claim' }]);
 });
});

describe('login attempts', () => {
 const attempt = (o = {}) => ({ stateHash: randomUUID(), bindingHash: 'b', codeVerifier: 'v', nonce: 'n', returnTo: '/', ttlSeconds: 600, ...o });
 test('are single use', async () => {
  const a = attempt(); await createLoginAttempt(db, a);
  expect(await consumeLoginAttempt(db, a.stateHash, 'b')).toEqual({ codeVerifier: 'v', nonce: 'n', returnTo: '/' });
  expect(await consumeLoginAttempt(db, a.stateHash, 'b')).toBeUndefined();
 });
 test('are bound to the starting browser', async () => {
  const a = attempt(); await createLoginAttempt(db, a);
  expect(await consumeLoginAttempt(db, a.stateHash, 'other-browser')).toBeUndefined();
  expect(await consumeLoginAttempt(db, a.stateHash, 'b')).toBeDefined();
 });
 test('expire', async () => {
  const a = attempt({ ttlSeconds: 0 }); await createLoginAttempt(db, a);
  expect(await consumeLoginAttempt(db, a.stateHash, 'b')).toBeUndefined();
 });
 test('concurrent consumption succeeds once', async () => {
  const a = attempt(); await createLoginAttempt(db, a);
  const r = await Promise.all(Array.from({ length: 5 }, () => consumeLoginAttempt(db, a.stateHash, 'b')));
  expect(r.filter(Boolean)).toHaveLength(1);
 });
});

describe('sessions', () => {
 const start = async (absoluteMinutes = 60) => {
  const s = await ok(claims());
  const idHash = randomUUID();
  await createSession(db, { idHash, userId: s.userId, identityId: s.identityId, absoluteMinutes });
  return { ...s, idHash };
 };
 test('an active session returns the user and bundles', async () => {
  const s = await start();
  expect(await findSession(db, s.idHash, 60)).toMatchObject({ userId: s.userId, bundles: ['fleet-agent'] });
 });
 test('revoked sessions are denied', async () => {
  const s = await start();
  expect(await revokeSession(db, s.idHash)).toBe(s.userId);
  expect(await findSession(db, s.idHash, 60)).toBeUndefined();
 });
 test('idle and absolute limits are enforced', async () => {
  const idle = await start();
  await db.query(`UPDATE sessions SET last_seen_at = now() - interval '61 minutes' WHERE id_hash = $1`, [idle.idHash]);
  expect(await findSession(db, idle.idHash, 60)).toBeUndefined();
  const expired = await start();
  await db.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id_hash = $1`, [expired.idHash]);
  expect(await findSession(db, expired.idHash, 60)).toBeUndefined();
 });
 test('disabling a user denies existing sessions and new sign-ins; re-enabling does not revive old sessions', async () => {
  const c = claims();
  const s = await ok(c);
  const idHash = randomUUID();
  await createSession(db, { idHash, userId: s.userId, identityId: s.identityId, absoluteMinutes: 60 });
  await setUserEnabled(db, s.userId, false);
  expect(await findSession(db, idHash, 60)).toBeUndefined();
  expect(await signIn(db, c)).toEqual({ status: 'disabled', userId: s.userId });
  await setUserEnabled(db, s.userId, true);
  expect(await findSession(db, idHash, 60)).toBeUndefined();
 });
 test('the live-stream check is read-only unless touching, and sees every kind of revocation', async () => {
  const lastSeen = async (h: string) => (await db.query('SELECT last_seen_at FROM sessions WHERE id_hash = $1', [h])).rows[0].last_seen_at.getTime();
  const s = await start();
  await db.query(`UPDATE sessions SET last_seen_at = now() - interval '5 minutes' WHERE id_hash = $1`, [s.idHash]);
  const before = await lastSeen(s.idHash);
  expect(await sessionStillValid(db, s.idHash, 60, false)).toBe(true);
  expect(await lastSeen(s.idHash)).toBe(before);
  expect(await sessionStillValid(db, s.idHash, 60, true)).toBe(true);
  expect(await lastSeen(s.idHash)).toBeGreaterThan(before);

  const revoked = await start(); await revokeSession(db, revoked.idHash);
  const idle = await start(); await db.query(`UPDATE sessions SET last_seen_at = now() - interval '61 minutes' WHERE id_hash = $1`, [idle.idHash]);
  const disabled = await start(); await setUserEnabled(db, disabled.userId, false);
  for (const x of [revoked, idle, disabled]) for (const touch of [false, true]) expect(await sessionStillValid(db, x.idHash, 60, touch)).toBe(false);
 });
});

describe('login attempt hygiene', () => {
 test('consumed attempts keep no verifier, and expired attempts are purged on the next login', async () => {
  const live = { stateHash: randomUUID(), bindingHash: 'b', codeVerifier: 'v', nonce: 'n', returnTo: '/', ttlSeconds: 600 };
  const stale = { ...live, stateHash: randomUUID(), ttlSeconds: 0 };
  await createLoginAttempt(db, live);
  await consumeLoginAttempt(db, live.stateHash, 'b');
  await createLoginAttempt(db, stale);
  await createLoginAttempt(db, { ...live, stateHash: randomUUID() });
  const states = (await db.query('SELECT state_hash FROM login_attempts')).rows.map(r => r.state_hash);
  expect(states).not.toContain(live.stateHash);
  expect(states).not.toContain(stale.stateHash);
 });
});
