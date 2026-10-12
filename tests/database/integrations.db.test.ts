import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrate } from '../../packages/database/src';
import { signIn } from '../../apps/api/lib/auth/repository';
import { localSealer } from '../../apps/api/lib/crypto';
import { clientFor, ConnectionError, createConnection, rotateCredential, setKillSwitch, testConnection } from '../../apps/api/lib/integrations/connections';
import { apiKeyFor, startMockElastic, type MockElastic, type MockKey } from '../../tools/mock-elastic/elastic.mts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for database tests');
// The connection rules read ELASTIC_ALLOWED_HOSTS through the API config.
process.env.ELASTIC_ALLOWED_HOSTS = '127.0.0.1';
const schema = 'integrations_' + randomUUID().replaceAll('-', '');
const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Pool({ connectionString: url, max: 1 });
const db = new Pool({ connectionString: scoped.toString(), max: 4 });
const seal = localSealer(Buffer.alloc(32, 7).toString('base64'));
const keys: MockKey[] = JSON.parse(await readFile(new URL('../../tools/mock-elastic/keys.json', import.meta.url), 'utf8')).keys;
let mock: MockElastic;
let actor: string;

beforeAll(async () => {
 await admin.query(`CREATE SCHEMA ${schema}`);
 const dir = new URL('../../packages/database/migrations/', import.meta.url);
 const files = (await readdir(dir)).filter(f => /^\d{4}\.sql$/.test(f)).sort();
 await migrate(scoped.toString(), await Promise.all(files.map(async f => ({ version: f.slice(0, 4), sql: await readFile(new URL(f, dir), 'utf8') }))));
 mock = await startMockElastic({ keys });
 const r = await signIn(db, { issuer: 'https://idp.test', subject: 's-' + randomUUID(), displayName: 'Ada', email: 'ada@example.test', bundles: ['fleet-admin'] });
 if (r.status !== 'ok') throw new Error('expected ok');
 actor = r.userId;
});
afterAll(async () => { await mock.close(); await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

const input = (name: string, keyId = 'resolve-reader') => ({
 name, elasticsearchUrl: mock.esUrl, kibanaUrl: mock.kibanaUrl, spaceId: 'support-ops', apiKey: apiKeyFor(keys.find(k => k.id === keyId)!),
});
const err = async (p: Promise<unknown>) => { try { await p; return 'none'; } catch (e) { return e instanceof ConnectionError ? e.code : String(e); } };
const audits = async (op: string) => (await db.query('SELECT outcome, summary FROM audit_events WHERE operation = $1 ORDER BY at', [op])).rows;

describe('Elastic connections', () => {
 test('the key is sealed to its row and never stored or returned in plain text; creation is audited without it', async () => {
  const c = await createConnection(db, seal, actor, input('Sealed'));
  expect(JSON.stringify(c)).not.toContain('dev-only');
  const row = (await db.query('SELECT credential_enc FROM integration_connections WHERE id = $1', [c.id])).rows[0];
  expect(row.credential_enc).toMatch(/^v1:/);
  expect(row.credential_enc).not.toContain(input('x').apiKey);
  // Bound to the row: copying the ciphertext to another connection cannot be opened there.
  const other = await createConnection(db, seal, actor, input('Other'));
  await db.query('UPDATE integration_connections SET credential_enc = $1 WHERE id = $2', [row.credential_enc, other.id]);
  await expect(clientFor(db, seal, other.id)).rejects.toThrow();
  const a = (await audits('observability.connection_create')).find(x => x.summary.connectionId === c.id);
  expect(a).toMatchObject({ outcome: 'succeeded', summary: { credential: 'sealed', spaceId: 'support-ops' } });
  expect(JSON.stringify(a)).not.toContain('dev-only');
 });

 test('hosts outside ELASTIC_ALLOWED_HOSTS and duplicate names are refused; exactly one credential source is enforced', async () => {
  expect(await err(createConnection(db, seal, actor, { ...input('Bad host'), elasticsearchUrl: 'https://es.elsewhere.example' }))).toBe('HOST_NOT_ALLOWED');
  await createConnection(db, seal, actor, input('Twice'));
  expect(await err(createConnection(db, seal, actor, input('Twice')))).toBe('NAME_TAKEN');
  expect(await err(createConnection(db, seal, actor, { ...input('Missing ref'), apiKey: undefined, secretRef: 'env:RESOLVE_TEST_NOT_SET' }))).toBe('SECRET_REF_UNAVAILABLE');
  await expect(db.query(`INSERT INTO integration_connections (provider, name, settings, created_by) VALUES ('elastic', 'none', '{}', $1)`, [actor])).rejects.toThrow(/check/i);
 });

 test('discovery records versions and each family; a narrow key is recorded as denied/unsupported, not hidden', async () => {
  const full = await testConnection(db, seal, actor, (await createConnection(db, seal, actor, input('Reader'))).id);
  expect(full.discovery).toMatchObject({ reachable: true, elasticsearch: { version: '9.1.0', buildFlavor: 'default' } });
  expect(Object.values(full.discovery!.families).every(f => f.status === 'supported')).toBe(true);
  const narrow = await testConnection(db, seal, actor, (await createConnection(db, seal, actor, input('Narrow', 'resolve-narrow'))).id);
  expect(narrow.discovery!.families).toMatchObject({ slo: { status: 'denied' }, cases: { status: 'denied' }, alerts: { status: 'unsupported' }, apm: { status: 'supported' } });
  const revoked = await testConnection(db, seal, actor, (await createConnection(db, seal, actor, input('Revoked', 'resolve-revoked'))).id);
  expect(revoked.discovery).toMatchObject({ reachable: false, failure: 'UNAUTHENTICATED' });
  expect((await audits('observability.connection_test')).map(a => a.outcome)).toEqual(['succeeded', 'succeeded', 'failed']);
 });

 test('rotation is version-checked, bumps the revision and clears discovery', async () => {
  const c = await testConnection(db, seal, actor, (await createConnection(db, seal, actor, input('Rotate', 'resolve-revoked'))).id);
  expect(await err(rotateCredential(db, seal, actor, c.id, { apiKey: input('x').apiKey, version: c.version + 5 }))).toBe('CONFLICT');
  const r = await rotateCredential(db, seal, actor, c.id, { apiKey: input('x').apiKey, version: c.version });
  expect(r).toMatchObject({ revision: c.revision + 1, discovery: null });
  expect((await testConnection(db, seal, actor, c.id)).discovery?.reachable).toBe(true);
 });

 test('the kill switch stops every read at once, with an audited reason, and can be turned off again', async () => {
  const c = await createConnection(db, seal, actor, input('Switch'));
  const on = await setKillSwitch(db, actor, c.id, { killSwitch: true, reason: 'Suspected key leak', version: c.version });
  expect(on).toMatchObject({ killSwitch: true, killSwitchReason: 'Suspected key leak', revision: c.revision + 1 });
  expect(await err(clientFor(db, seal, c.id))).toBe('KILL_SWITCH_ON');
  expect(await err(testConnection(db, seal, actor, c.id))).toBe('KILL_SWITCH_ON');
  expect(await err(setKillSwitch(db, actor, c.id, { killSwitch: false, reason: 'stale', version: c.version }))).toBe('CONFLICT');
  const off = await setKillSwitch(db, actor, c.id, { killSwitch: false, reason: 'Key rotated', version: on.version });
  expect(off.killSwitchReason).toBeNull();
  await expect(clientFor(db, seal, c.id)).resolves.toBeDefined();
  expect((await audits('observability.kill_switch')).filter(a => a.summary.connectionId === c.id).map(a => a.summary.killSwitch)).toEqual([true, false]);
 });
});

describe('observability schema rules (migration 0008)', () => {
 test('a mapping cannot be active without a passed preview and isolation check', async () => {
  const c = await createConnection(db, seal, actor, input('Mapping'));
  const insert = (state: string, preview: string | null, isolation: string | null) => db.query(
   `INSERT INTO elastic_app_mappings (app_key, environment, connection_id, mapping, state, preview_passed_at, isolation_passed_at, updated_by)
    VALUES ('payroll', $1, $2, '{}', $3, $4, $5, $6)`, [randomUUID().slice(0, 8), c.id, state, preview, isolation, actor]);
  await expect(insert('active', null, null)).rejects.toThrow(/check/i);
  await expect(insert('active', new Date().toISOString(), null)).rejects.toThrow(/check/i);
  await expect(insert('active', new Date().toISOString(), new Date().toISOString())).resolves.toBeDefined();
  await expect(insert('draft', null, null)).resolves.toBeDefined();
 });

 test('evidence snapshots are immutable except the note outcome and hold', async () => {
  const id = (await db.query(
   `INSERT INTO evidence_snapshots (app_key, environment, object_kind, object_id, requested_from, requested_to, facts, source_ids, query_revision, completeness, classification, content_hash, created_by, request_id, expires_at)
    VALUES ('payroll', 'production', 'ticket', 't1', now() - interval '1 day', now(), '{"a":1}', '[]', 'q1', 'complete', 'subject', 'h', $1, $2, now() + interval '30 days') RETURNING id`,
   [actor, randomUUID()])).rows[0].id;
  await expect(db.query(`UPDATE evidence_snapshots SET facts = '{"a":2}' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
  await expect(db.query(`UPDATE evidence_snapshots SET content_hash = 'x' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
  await db.query(`UPDATE evidence_snapshots SET note_state = 'succeeded', hold = true WHERE id = $1`, [id]);
  expect((await db.query('SELECT note_state, hold FROM evidence_snapshots WHERE id = $1', [id])).rows[0]).toEqual({ note_state: 'succeeded', hold: true });
 });

 test('one link per issue and object; one known issue per provider id per app and space', async () => {
  const c = await createConnection(db, seal, actor, input('Issues'));
  const issue = () => db.query(
   `INSERT INTO known_issues (connection_id, space_id, app_key, environment, provider_kind, provider_id, title, state, criteria, first_seen_at, last_seen_at)
    VALUES ($1, 'support-ops', 'payroll', 'production', 'case', 'case-payroll-1182', 'Payslips', 'active', '{}', now(), now()) RETURNING id`, [c.id]);
  const issueId = (await issue()).rows[0].id;
  await expect(issue()).rejects.toThrow(/unique|duplicate/i);
  const link = () => db.query(`INSERT INTO known_issue_links (issue_id, app_key, object_kind, object_id, linked_by, matched_criteria, request_id) VALUES ($1, 'payroll', 'ticket', 't9', $2, '{}', $3)`, [issueId, actor, randomUUID()]);
  await link();
  await expect(link()).rejects.toThrow(/unique|duplicate/i);
 });
});
