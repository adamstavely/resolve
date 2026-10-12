import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ElasticAppMapping, RegistryApp } from '../../packages/contracts/src';
import { migrate } from '../../packages/database/src';
import { signIn } from '../../apps/api/lib/auth/repository';
import { localSealer } from '../../apps/api/lib/crypto';
import { ConnectionError, createConnection, rotateCredential, setKillSwitch } from '../../apps/api/lib/integrations/connections';
import { isolationCheck, previewMapping, saveMapping, setMappingState } from '../../apps/api/lib/integrations/mappings';
import { activeIssues, fleetHealth } from '../../apps/api/lib/integrations/observability';
import { claim, ensureOperations, pollOnce, prune } from '../../apps/api/lib/integrations/poller';
import { apiKeyFor, startMockElastic, type MockElastic, type MockKey } from '../../tools/mock-elastic/elastic.mts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for database tests');
process.env.ELASTIC_ALLOWED_HOSTS = '127.0.0.1';
const schema = 'observability_' + randomUUID().replaceAll('-', '');
const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Pool({ connectionString: url, max: 1 });
const db = new Pool({ connectionString: scoped.toString(), max: 6 });
const seal = localSealer(Buffer.alloc(32, 9).toString('base64'));
const keys: MockKey[] = JSON.parse(await readFile(new URL('../../tools/mock-elastic/keys.json', import.meta.url), 'utf8')).keys;
const POLL = 30;
let mock: MockElastic;
let actor: string;
let conn: { id: string; version: number };

const app = (appKey: string): RegistryApp => ({ appKey, displayName: appKey, supportOrigin: 'https://x.test', routable: true, dormant: false, state: 'active', deploymentVersion: 'v', protocolVersions: [1], lastActivityAt: null });
const mapping = (appKey: 'payroll' | 'hr', connectionId: string): ElasticAppMapping => ({
 appKey, environment: 'production', connectionId,
 indices: { apm: ['traces-apm-*', 'logs-apm.error-*'], rum: ['traces-apm.rum-*'], logs: [], synthetics: ['synthetics-*'] },
 services: appKey === 'payroll'
  ? [{ name: 'payroll-api', environment: 'production', discriminator: null }, { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'payroll' } }]
  : [{ name: 'hr-api', environment: 'production', discriminator: null }, { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'hr' } }],
 sloIds: appKey === 'payroll' ? ['payroll-payslip-availability', 'payroll-login-latency'] : ['hr-availability'],
 monitorIds: appKey === 'payroll' ? ['payroll-login', 'payroll-payslip'] : ['hr-login'],
 alertRuleIds: appKey === 'payroll' ? ['payroll-api-5xx-eu-west'] : ['hr-api-errors'],
 caseTags: [`app:${appKey}`], deepLinkBase: null, subjectPolicy: 'verified_external_id',
});
const err = async (p: Promise<unknown>) => { try { await p; return 'none'; } catch (e) { return e instanceof ConnectionError ? e.code : String(e); } };

async function activate(appKey: 'payroll' | 'hr') {
 const saved = await saveMapping(db, actor, mapping(appKey, conn.id), (await db.query('SELECT version FROM elastic_app_mappings WHERE app_key = $1', [appKey])).rows[0]?.version ?? null);
 await previewMapping(db, seal, actor, appKey, 'production');
 const checked = await isolationCheck(db, seal, actor, appKey, 'production');
 expect(checked.preview?.passed && checked.isolation?.passed, `${appKey} checks`).toBe(true);
 return setMappingState(db, actor, appKey, 'production', 'active', checked.version).then(v => ({ saved, v }));
}
async function pollApp(appKey: string) {
 await ensureOperations(db);
 // Only the app under test is due.
 await db.query(`UPDATE integration_operations SET not_before = CASE WHEN operation_key = $1 THEN now() - interval '1 second' ELSE now() + interval '1 hour' END`, [`${appKey}:production`]);
 const op = await claim(db, 'test-worker');
 expect(op?.operation_key).toBe(`${appKey}:production`);
 return pollOnce(db, seal, op!, POLL);
}

beforeAll(async () => {
 await admin.query(`CREATE SCHEMA ${schema}`);
 const dir = new URL('../../packages/database/migrations/', import.meta.url);
 const files = (await readdir(dir)).filter(f => /^\d{4}\.sql$/.test(f)).sort();
 await migrate(scoped.toString(), await Promise.all(files.map(async f => ({ version: f.slice(0, 4), sql: await readFile(new URL(f, dir), 'utf8') }))));
 mock = await startMockElastic({ keys });
 const r = await signIn(db, { issuer: 'https://idp.test', subject: 's-' + randomUUID(), displayName: 'Ada', email: 'ada@example.test', bundles: ['fleet-admin'] });
 if (r.status !== 'ok') throw new Error('expected ok');
 actor = r.userId;
 conn = await createConnection(db, seal, actor, { name: 'Mock', elasticsearchUrl: mock.esUrl, kibanaUrl: mock.kibanaUrl, spaceId: 'support-ops', apiKey: apiKeyFor(keys[0]) });
});
afterAll(async () => { await mock.close(); await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(() => mock.reset());

describe('mapping lifecycle', () => {
 test('a draft is not polled; activation needs a passed preview and isolation check; editing returns it to draft', async () => {
  const draft = await saveMapping(db, actor, mapping('payroll', conn.id), null);
  expect(draft.state).toBe('draft');
  expect(await err(setMappingState(db, actor, 'payroll', 'production', 'active', draft.version))).toBe('CHECKS_REQUIRED');
  await ensureOperations(db);
  expect(await claim(db, 'w')).toBeUndefined();
  const { v } = await activate('payroll');
  expect(v.state).toBe('active');
  const edited = await saveMapping(db, actor, { ...mapping('payroll', conn.id), caseTags: [] }, v.version);
  expect(edited).toMatchObject({ state: 'draft', preview: null, isolation: null, revision: v.revision + 1 });
  expect(await err(saveMapping(db, actor, mapping('payroll', conn.id), v.version))).toBe('CONFLICT');
  await activate('payroll');
  const audit = (await db.query(`SELECT operation FROM audit_events WHERE operation LIKE 'observability.mapping%'`)).rows.map(r => r.operation);
  expect(audit).toEqual(expect.arrayContaining(['observability.mapping_save', 'observability.mapping_preview', 'observability.mapping_isolation', 'observability.mapping_state']));
 });
});

describe('polling', () => {
 test('a poll commits health, known issues with affected counts, and invalidations, under its lease', async () => {
  await activate('hr');
  const notified: string[] = [];
  const listener = await db.connect();
  await listener.query('LISTEN resolve_observability');
  listener.on('notification', n => notified.push(n.payload ?? ''));
  expect(await pollApp('payroll')).toMatchObject({ outcome: 'polled', state: 'degraded' });
  expect(await pollApp('hr')).toMatchObject({ outcome: 'polled', state: 'healthy' });
  await new Promise(r => setTimeout(r, 100));
  listener.release();
  expect(notified.map(n => JSON.parse(n).type)).toEqual(['health', 'issues', 'health', 'issues']);

  const health = await fleetHealth(db, [app('payroll'), app('hr'), app('legal')], POLL);
  expect(health.map(h => [h.appKey, h.state, h.reason])).toEqual([['payroll', 'degraded', null], ['hr', 'healthy', null], ['legal', 'unknown', 'not_configured']]);
  expect(health[0].provenance).toMatchObject({ completeness: 'complete', missing: [], connectionRevision: 1, schemaVersion: 1 });
  const issues = await activeIssues(db, ['payroll', 'hr']);
  // Newest first: the case was opened after the alert started.
  expect(issues.map(i => [i.appKey, i.kind, i.providerId])).toEqual([['payroll', 'case', 'case-payroll-1182'], ['payroll', 'alert', expect.any(String)]]);
  const alert = issues[1];
  expect(alert.affected).toMatchObject({ count: 18, approximate: true });
  expect(alert.title).not.toContain('dev-secret');
 });

 test('an alert that recovers leaves the list; a failed alerts read closes nothing', async () => {
  const alerts = mock.state.scenario.indices.get('.alerts-observability.apm.alerts-default')!;
  const active = alerts.find(d => d.source['kibana.alert.rule.uuid'] === 'payroll-api-5xx-eu-west' && d.source['kibana.space_ids'] && (d.source['kibana.space_ids'] as string[]).includes('support-ops'))!;
  await pollApp('payroll');
  await fetch(`${mock.esUrl}/dev/fault`, { method: 'POST', body: JSON.stringify({ kind: 'unavailable' }) });
  expect(await pollApp('payroll')).toMatchObject({ outcome: 'deferred', failure: 'UPSTREAM_ERROR' });
  expect((await activeIssues(db, ['payroll'])).some(i => i.kind === 'alert')).toBe(true);
  await fetch(`${mock.esUrl}/dev/fault`, { method: 'POST', body: JSON.stringify({ kind: 'none' }) });
  active.source['kibana.alert.status'] = 'recovered';
  await pollApp('payroll');
  expect((await activeIssues(db, ['payroll'])).map(i => i.kind)).toEqual(['case']);
 });

 test('network trouble keeps the last snapshot (it goes stale) and backs off; 429 honours Retry-After', async () => {
  await pollApp('payroll');
  const before = (await db.query(`SELECT count(*)::int AS n FROM observability_health_snapshots WHERE app_key = 'payroll'`)).rows[0].n;
  await fetch(`${mock.esUrl}/dev/fault`, { method: 'POST', body: JSON.stringify({ kind: 'unavailable' }) });
  expect((await pollApp('payroll')).outcome).toBe('deferred');
  expect((await db.query(`SELECT count(*)::int AS n FROM observability_health_snapshots WHERE app_key = 'payroll'`)).rows[0].n).toBe(before);
  const wait = (await db.query(`SELECT extract(epoch FROM not_before - now()) AS s, failure_code FROM integration_operations WHERE operation_key = 'payroll:production'`)).rows[0];
  expect(Number(wait.s)).toBeGreaterThan(POLL);
  const later = await fleetHealth(db, [app('payroll')], POLL, Date.now() + 3 * POLL * 1000);
  expect(later[0].state).toBe('stale');
  expect(later[0].components.length).toBeGreaterThan(0);
  await fetch(`${mock.esUrl}/dev/fault`, { method: 'POST', body: JSON.stringify({ kind: 'rate_limit', count: 5, retryAfter: 120 }) });
  expect(await pollApp('payroll')).toMatchObject({ outcome: 'deferred', failure: 'RATE_LIMITED' });
  const rl = (await db.query(`SELECT extract(epoch FROM not_before - now()) AS s FROM integration_operations WHERE operation_key = 'payroll:production'`)).rows[0];
  expect(Number(rl.s)).toBeGreaterThan(100);
 });

 test('a refused credential shows unavailable at once; the kill switch stops polling', async () => {
  const c = (await db.query('SELECT version FROM integration_connections WHERE id = $1', [conn.id])).rows[0];
  await rotateCredential(db, seal, actor, conn.id, { apiKey: apiKeyFor(keys.find(k => k.id === 'resolve-revoked')!), version: c.version });
  expect((await pollApp('payroll')).outcome).toBe('unavailable');
  const h = await fleetHealth(db, [app('payroll')], POLL);
  expect(h[0]).toMatchObject({ state: 'unknown', reason: 'connection_unavailable' });
  const c2 = (await db.query('SELECT version FROM integration_connections WHERE id = $1', [conn.id])).rows[0];
  const back = await rotateCredential(db, seal, actor, conn.id, { apiKey: apiKeyFor(keys[0]), version: c2.version });
  const off = await setKillSwitch(db, actor, conn.id, { killSwitch: true, reason: 'Drill', version: back.version });
  await ensureOperations(db);
  await db.query(`UPDATE integration_operations SET not_before = now()`);
  expect(await claim(db, 'w')).toBeUndefined();
  expect((await fleetHealth(db, [app('payroll')], POLL))[0]).toMatchObject({ state: 'unknown', reason: 'kill_switch' });
  expect(await activeIssues(db, ['payroll'])).toEqual([]);
  await setKillSwitch(db, actor, conn.id, { killSwitch: false, reason: 'Drill over', version: off.version });
  expect((await pollApp('payroll')).outcome).toBe('polled');
 });

 test('a worker that lost its lease writes nothing (fencing)', async () => {
  await ensureOperations(db);
  await db.query(`UPDATE integration_operations SET not_before = now() WHERE operation_key = 'payroll:production'`);
  const first = (await claim(db, 'slow-worker'))!;
  await db.query(`UPDATE integration_operations SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [first.id]);
  const second = (await claim(db, 'fast-worker'))!;
  expect(BigInt(second.fencing_token)).toBeGreaterThan(BigInt(first.fencing_token));
  const before = (await db.query('SELECT count(*)::int AS n FROM observability_health_snapshots')).rows[0].n;
  expect(await pollOnce(db, seal, first, POLL)).toEqual({ outcome: 'fenced' });
  expect((await db.query('SELECT count(*)::int AS n FROM observability_health_snapshots')).rows[0].n).toBe(before);
  expect((await pollOnce(db, seal, second, POLL)).outcome).toBe('polled');
 });

 test('history beyond 24 hours is pruned; the latest snapshot always stays', async () => {
  await db.query(`UPDATE observability_health_snapshots SET fetched_at = fetched_at - interval '2 days'`);
  await prune(db);
  const left = (await db.query(`SELECT app_key, count(*)::int AS n FROM observability_health_snapshots GROUP BY app_key ORDER BY app_key`)).rows;
  expect(left).toEqual([{ app_key: 'hr', n: 1 }, { app_key: 'payroll', n: 1 }]);
 });
});
