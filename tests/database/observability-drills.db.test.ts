import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ElasticAppMapping, ObservabilityEvent, RegistryApp } from '../../packages/contracts/src';
import { migrate } from '../../packages/database/src';
import { signIn } from '../../apps/api/lib/auth/repository';
import { localSealer } from '../../apps/api/lib/crypto';
import { createConnection, rotateCredential, setKillSwitch } from '../../apps/api/lib/integrations/connections';
import { isolationCheck, previewMapping, saveMapping, setMappingState } from '../../apps/api/lib/integrations/mappings';
import { fleetHealth } from '../../apps/api/lib/integrations/observability';
import { claim, ensureOperations, pollOnce } from '../../apps/api/lib/integrations/poller';
import { trackReceipt, watchReceipts } from '../../apps/api/lib/integrations/receipts';
import { loadSnapshot } from '../../apps/api/lib/integrations/evidence';
import { LISTENER_NAME, notifyObservability, subscribeObservability } from '../../apps/api/lib/integrations/notify';
import { apiKeyFor, startMockElastic, type MockElastic, type MockKey } from '../../tools/mock-elastic/elastic.mts';

/*
 * E5 failure drills (plan 12 §9, plan 14), run locally against PostgreSQL and the in-process mock Elastic: slow indices,
 * rollover, mapping changes, a key revoked mid-run, a worker crash, late telemetry, retention expiry, UTC/DST windows and
 * a reconnect storm on the invalidation stream. Each drill states the behaviour it proves.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for database tests');
process.env.ELASTIC_ALLOWED_HOSTS = '127.0.0.1';
const schema = 'drills_' + randomUUID().replaceAll('-', '');
const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Pool({ connectionString: url, max: 2 });
const db = new Pool({ connectionString: scoped.toString(), max: 6 });
const seal = localSealer(Buffer.alloc(32, 5).toString('base64'));
const keys: MockKey[] = JSON.parse(await readFile(new URL('../../tools/mock-elastic/keys.json', import.meta.url), 'utf8')).keys;
const POLL = 30;
let mock: MockElastic; let actor: string; let conn: { id: string; version: number };
const app: RegistryApp = { appKey: 'payroll', displayName: 'Payroll', supportOrigin: 'https://x.test', routable: true, dormant: false, state: 'active', deploymentVersion: 'v', protocolVersions: [1], lastActivityAt: null };
const mapping = (connectionId: string): ElasticAppMapping => ({
 appKey: 'payroll', environment: 'production', connectionId,
 indices: { apm: ['traces-apm-*', 'logs-apm.error-*'], rum: ['traces-apm.rum-*'], logs: [], synthetics: ['synthetics-*'] },
 services: [{ name: 'payroll-api', environment: 'production', discriminator: null }, { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'payroll' } }],
 sloIds: ['payroll-payslip-availability', 'payroll-login-latency'], monitorIds: ['payroll-login', 'payroll-payslip'], alertRuleIds: ['payroll-api-5xx-eu-west'], caseTags: ['app:payroll'],
 deepLinkBase: null, subjectPolicy: 'verified_external_id',
});
async function poll() {
 await ensureOperations(db);
 await db.query(`UPDATE integration_operations SET not_before = now() - interval '1 second', state = 'pending', lease_expires_at = NULL`);
 const op = await claim(db, 'drill-worker');
 return pollOnce(db, seal, op!, POLL);
}
const latest = async () => (await fleetHealth(db, [app], POLL))[0];

beforeAll(async () => {
 await admin.query(`CREATE SCHEMA ${schema}`);
 const dir = new URL('../../packages/database/migrations/', import.meta.url);
 const files = (await readdir(dir)).filter(f => /^\d{4}\.sql$/.test(f)).sort();
 await migrate(scoped.toString(), await Promise.all(files.map(async f => ({ version: f.slice(0, 4), sql: await readFile(new URL(f, dir), 'utf8') }))));
 mock = await startMockElastic({ keys });
 const r = await signIn(db, { issuer: 'https://idp.test', subject: 's-' + randomUUID(), displayName: 'Ada', email: 'ada@example.test', bundles: ['fleet-admin'] });
 if (r.status !== 'ok') throw new Error('expected ok');
 actor = r.userId;
 conn = await createConnection(db, seal, actor, { name: 'Drills', elasticsearchUrl: mock.esUrl, kibanaUrl: mock.kibanaUrl, spaceId: 'support-ops', apiKey: apiKeyFor(keys[0]) });
 await saveMapping(db, actor, mapping(conn.id), null);
 await previewMapping(db, seal, actor, 'payroll', 'production');
 const v = await isolationCheck(db, seal, actor, 'payroll', 'production');
 await setMappingState(db, actor, 'payroll', 'production', 'active', v.version);
});
afterAll(async () => { await mock.close(); await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(() => mock.reset());

describe('E5 drills', () => {
 test('shared read cache: a kill switch and a new poll are visible on the very next read, inside the cache lifetime', async () => {
  await poll();
  expect((await fleetHealth(db, [app], POLL)).at(0)?.reason).toBeNull();
  const c = (await db.query('SELECT version FROM integration_connections WHERE id = $1', [conn.id])).rows[0];
  const on = await setKillSwitch(db, actor, conn.id, { killSwitch: true, reason: 'Drill', version: c.version });
  expect((await fleetHealth(db, [app], POLL)).at(0)?.reason).toBe('kill_switch');
  await setKillSwitch(db, actor, conn.id, { killSwitch: false, reason: 'Drill over', version: on.version });
  const before = (await fleetHealth(db, [app], POLL)).at(0)?.provenance?.fetchedAt;
  await poll();
  expect((await fleetHealth(db, [app], POLL)).at(0)?.provenance?.fetchedAt).not.toBe(before);
 });

 test('slow index: a poll that times out defers with backoff and leaves the last snapshot to go stale, never "healthy"', async () => {
  expect((await poll()).outcome).toBe('polled');
  // The client's 10 s timeout is the bound; the drill makes every Elasticsearch and Kibana call slower than that.
  mock.state.fault = { kind: 'slow', ms: 11_000 };
  const r = await poll();
  expect(r).toMatchObject({ outcome: 'deferred', failure: 'TIMEOUT' });
  mock.state.fault = { kind: 'none' };
  const later = (await fleetHealth(db, [app], POLL, Date.now() + 3 * POLL * 1000))[0];
  expect(later.state).toBe('stale');
 }, 40_000);

 test('rollover: a new backing index is picked up through the data-stream pattern; the old one may disappear', async () => {
  const docs = mock.state.scenario.indices.get('synthetics-browser-default')!;
  mock.state.scenario.indices.delete('synthetics-browser-default');
  mock.state.scenario.indices.set('synthetics-browser-default-000002', docs.map(d => ({ ...d, _index: 'synthetics-browser-default-000002' })));
  expect(await poll()).toMatchObject({ outcome: 'polled', state: 'degraded' });
  expect((await latest()).summary.synthetics.total).toBe(4);
 });

 test('mapping change: a renamed field drops the unparsable results and shows as unknown, not as passing', async () => {
  for (const d of mock.state.scenario.indices.get('synthetics-browser-default')!) { d.source['monitor.result'] = d.source['monitor.status']; delete d.source['monitor.status']; }
  await poll();
  const h = await latest();
  expect(h.summary.synthetics.total).toBe(0);
  expect(h.components.filter(c => c.family === 'synthetics').every(c => c.state === 'unknown')).toBe(true);
 });

 test('a key revoked mid-run: the next poll records "unavailable" at once; rotating restores it', async () => {
  expect((await poll()).outcome).toBe('polled');
  mock.state.keys.find(k => k.id === 'resolve-reader')!.revoked = true;
  expect((await poll()).outcome).toBe('unavailable');
  expect(await latest()).toMatchObject({ state: 'unknown', reason: 'connection_unavailable' });
  mock.state.keys.find(k => k.id === 'resolve-reader')!.revoked = false;
  expect((await poll()).outcome).toBe('polled');
  const c = (await db.query('SELECT version FROM integration_connections WHERE id = $1', [conn.id])).rows[0];
  await rotateCredential(db, seal, actor, conn.id, { apiKey: apiKeyFor(keys[0]), version: c.version });
  expect((await poll()).outcome).toBe('polled');
 });

 test('worker crash: a lease held by a dead worker expires, another worker takes over, and the dead one cannot write', async () => {
  await ensureOperations(db);
  await db.query(`UPDATE integration_operations SET not_before = now() - interval '1 second', state = 'pending', lease_expires_at = NULL`);
  const dead = (await claim(db, 'crashed-worker'))!;
  expect(await claim(db, 'other-worker')).toBeUndefined(); // still leased
  await db.query(`UPDATE integration_operations SET lease_expires_at = now() - interval '1 second'`);
  const next = (await claim(db, 'other-worker'))!;
  expect((await pollOnce(db, seal, next, POLL)).outcome).toBe('polled');
  expect(await pollOnce(db, seal, dead, POLL)).toEqual({ outcome: 'fenced' });
 });

 test('late telemetry: a receipt past its watch window is "unverified", and evidence that arrives later upgrades it', async () => {
  const opId = randomUUID();
  await trackReceipt(db, { id: opId, app_key: 'payroll', operation: 'ticket.reply' });
  await db.query(`UPDATE action_receipt_observations SET deadline_at = now() - interval '1 second' WHERE operation_id = $1`, [opId]);
  await watchReceipts(db, seal);
  expect((await db.query('SELECT state FROM action_receipt_observations WHERE operation_id = $1', [opId])).rows[0].state).toBe('unverified');
  mock.state.scenario.indices.get('traces-apm-default')!.push({ _id: 'late', _index: 'traces-apm-default', source: {
   '@timestamp': new Date().toISOString(), 'service.name': 'notification-service', 'labels.resolve_operation_id': opId, 'http.response.status_code': 202, 'event.outcome': 'success' } });
  await watchReceipts(db, seal);
  expect((await db.query('SELECT state, source FROM action_receipt_observations WHERE operation_id = $1', [opId])).rows[0]).toEqual({ state: 'observed', source: 'notification-service' });
 });

 test('retention: an expired snapshot is gone unless on hold', async () => {
  const insert = async (expiresDays: number, hold: boolean) => (await db.query(
   `INSERT INTO evidence_snapshots (app_key, environment, object_kind, object_id, requested_from, requested_to, facts, source_ids, query_revision, completeness, classification, content_hash, created_by, request_id, expires_at, hold)
    VALUES ('payroll', 'production', 'ticket', 't', now() - interval '1 day', now(), '{"restricted":{"logs":[],"traces":[]}}', '[]', 'q', 'complete', 'service', 'h', $1, $2, now() + make_interval(days => $3), $4) RETURNING id`,
   [actor, randomUUID(), expiresDays, hold])).rows[0].id as string;
  expect(await loadSnapshot(db, await insert(-1, false))).toBeNull();
  expect(await loadSnapshot(db, await insert(-1, true))).not.toBeNull();
  expect(await loadSnapshot(db, await insert(30, false))).not.toBeNull();
 });

 test('UTC and DST: windows are absolute instants, so a 24-hour window across a DST change is exactly 24 hours', async () => {
  const { fetchSubjectEvents } = await import('../../apps/api/lib/integrations/elastic/families');
  const { ElasticClient } = await import('../../apps/api/lib/integrations/elastic/client');
  const c = new ElasticClient({ elasticsearchUrl: mock.esUrl, kibanaUrl: mock.kibanaUrl, spaceId: 'support-ops', apiKey: apiKeyFor(keys[0]), caPem: null }, { allowedHosts: ['127.0.0.1'], production: false });
  // Europe's clocks go back on 2026-10-25 at 01:00 UTC. Events stamped in UTC on either side of it.
  const docs = mock.state.scenario.indices.get('logs-apm.error-default')!;
  for (const [i, t] of ['2026-10-24T23:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-10-25T23:59:00Z'].entries())
   docs.push({ _id: `dst${i}`, _index: 'logs-apm.error-default', source: { '@timestamp': t, 'processor.event': 'error', 'service.name': 'payroll-api', 'service.environment': 'production', 'user.id': 'dst-subject', 'error.grouping_name': 'x' } });
  const from = new Date('2026-10-25T00:00:00Z'), to = new Date(from.getTime() + 24 * 3600_000);
  const r = await fetchSubjectEvents(c, 'APM', ['logs-apm.error-*'], 'dst-subject', mapping(conn.id).services, { from, to });
  expect(r.items.map(e => e.at)).toEqual(['2026-10-25T23:59:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-25T00:30:00.000Z']);
  expect(to.getTime() - from.getTime()).toBe(86_400_000);
 });

 test('reconnect storm: 300 open streams share one listener; when it is cut, every stream is told to re-read and keeps receiving', async () => {
  const received = new Array(300).fill(0); const gaps = new Array(300).fill(0);
  const unsub = received.map((_, i) => subscribeObservability((e: ObservabilityEvent) => { if (e.type === 'health') received[i]++; }, () => { gaps[i]++; }));
  const listeners = async () => Number((await admin.query(`SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database()`, [LISTENER_NAME])).rows[0].count);
  await expect.poll(listeners, { timeout: 5000 }).toBe(1);
  const send = () => notifyObservability(db, { type: 'health', appKey: 'payroll', environment: 'production', at: new Date().toISOString() });
  await expect.poll(async () => { await send(); return received.every(n => n > 0); }, { timeout: 5000 }).toBe(true);
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`, [LISTENER_NAME]);
  await expect.poll(() => gaps.every(n => n > 0), { timeout: 10_000 }).toBe(true);
  const before = [...received];
  await expect.poll(async () => { await send(); return received.every((n, i) => n > before[i]); }, { timeout: 10_000 }).toBe(true);
  await expect.poll(listeners, { timeout: 5000 }).toBe(1);
  unsub.forEach(u => u());
 }, 40_000);
});
