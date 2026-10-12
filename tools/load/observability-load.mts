/*
 * Observability load harness (plan 14, E5). Runs the real worker, read models, invalidation stream and customer-context
 * queries against PostgreSQL (a throwaway schema) and an in-process mock Elastic with a simulated per-request latency.
 * It answers the qualification questions that do not need a real cluster:
 * - Can W workers keep N mapped apps fresh at a P-second poll (no snapshot older than two polls)?
 * - Do readers cost Elastic anything? (They must not: browsers read snapshots.)
 * - How fast are customer-context queries at C concurrent agents?
 * - How does one listener per process fan invalidations out to S open streams?
 * Real-cluster latency, index sizes and network are not modelled; repeat in staging with the agreed volumes.
 *
 *   npm run load:observability -- --apps 50 --workers 4 --poll 5 --seconds 20 --readers 100 --agents 50 --subscribers 500 --latency 20
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { ElasticAppMapping, RegistryApp } from '../../packages/contracts/src';
import { migrate } from '../../packages/database/src';
import { signIn } from '../../apps/api/lib/auth/repository';
import { localSealer } from '../../apps/api/lib/crypto';
import { ElasticClient } from '../../apps/api/lib/integrations/elastic/client';
import { fetchSubjectEvents, fetchSynthetics } from '../../apps/api/lib/integrations/elastic/families';
import { createConnection } from '../../apps/api/lib/integrations/connections';
import { activeIssues, fleetHealth } from '../../apps/api/lib/integrations/observability';
import { claim, ensureOperations, pollOnce } from '../../apps/api/lib/integrations/poller';
import { notifyObservability, subscribeObservability } from '../../apps/api/lib/integrations/notify';
import { apiKeyFor, startMockElastic, type MockKey } from '../mock-elastic/elastic.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Development only');
const arg = (name: string, d: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const APPS = arg('apps', 50), WORKERS = arg('workers', 4), POLL = arg('poll', 5), SECONDS = arg('seconds', 20);
const READERS = arg('readers', 100), AGENTS = arg('agents', 50), SUBSCRIBERS = arg('subscribers', 500), LATENCY = arg('latency', 20);
process.env.ELASTIC_ALLOWED_HOSTS = '127.0.0.1';

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };
const timed = async <T,>(work: () => Promise<T>, into: number[]) => { const t = performance.now(); const r = await work(); into.push(performance.now() - t); return r; };

const url = process.env.DATABASE_URL!;
const schema = 'load_' + randomUUID().replaceAll('-', '');
const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Pool({ connectionString: url, max: 1 });
const db = new Pool({ connectionString: scoped.toString(), max: 20 });
const seal = localSealer(Buffer.alloc(32, 3).toString('base64'));
const keys: MockKey[] = JSON.parse(await readFile(new URL('../mock-elastic/keys.json', import.meta.url), 'utf8')).keys;
const mock = await startMockElastic({ keys });
const results: [string, string][] = [];

try {
 await admin.query(`CREATE SCHEMA ${schema}`);
 const dir = new URL('../../packages/database/migrations/', import.meta.url);
 const files = (await readdir(dir)).filter(f => /^\d{4}\.sql$/.test(f)).sort();
 await migrate(scoped.toString(), await Promise.all(files.map(async f => ({ version: f.slice(0, 4), sql: await readFile(new URL(f, dir), 'utf8') }))));
 const who = await signIn(db, { issuer: 'https://idp.test', subject: 'load', displayName: 'Load', email: 'load@example.test', bundles: ['fleet-admin'] });
 if (who.status !== 'ok') throw new Error('sign-in');
 const conn = await createConnection(db, seal, who.userId, { name: 'Load', elasticsearchUrl: mock.esUrl, kibanaUrl: mock.kibanaUrl, spaceId: 'support-ops', apiKey: apiKeyFor(keys[0]) });

 // N apps: payroll's mapping shape, each told apart by a discriminator (so queries run, and only payroll has data).
 const apps: RegistryApp[] = [];
 for (let i = 0; i < APPS; i++) {
  const appKey = i === 0 ? 'payroll' : `load-app-${i}`;
  apps.push({ appKey, displayName: appKey, supportOrigin: 'https://x.test', routable: true, dormant: false, state: 'active', deploymentVersion: 'v', protocolVersions: [1], lastActivityAt: null });
  const m: ElasticAppMapping = {
   appKey, environment: 'production', connectionId: conn.id,
   indices: { apm: ['traces-apm-*', 'logs-apm.error-*'], rum: ['traces-apm.rum-*'], logs: [], synthetics: ['synthetics-*'] },
   services: i === 0 ? [{ name: 'payroll-api', environment: 'production', discriminator: null }] : [{ name: 'shared-api', environment: 'production', discriminator: { field: 'labels.app', value: appKey } }],
   sloIds: i === 0 ? ['payroll-payslip-availability', 'payroll-login-latency'] : [], monitorIds: i === 0 ? ['payroll-login', 'payroll-payslip'] : [`m-${i}`],
   alertRuleIds: i === 0 ? ['payroll-api-5xx-eu-west'] : [`r-${i}`], caseTags: [`app:${appKey}`], deepLinkBase: null, subjectPolicy: 'verified_external_id',
  };
  await db.query(`INSERT INTO elastic_app_mappings (app_key, environment, connection_id, mapping, state, preview_passed_at, isolation_passed_at, updated_by) VALUES ($1, 'production', $2, $3, 'active', now(), now(), $4)`,
   [appKey, conn.id, JSON.stringify(m), who.userId]);
 }
 await ensureOperations(db);
 mock.state.fault = { kind: 'slow', ms: LATENCY };

 // ── 1. Workers keep N apps fresh ──
 const pollMs: number[] = []; let polls = 0; let deferred = 0;
 const callsBefore = mock.state.calls.es + mock.state.calls.kibana;
 const deadline = Date.now() + SECONDS * 1000;
 const lane = async (n: number) => {
  while (Date.now() < deadline) {
   const op = await claim(db, `load-${n}`);
   if (!op) { await new Promise(r => setTimeout(r, 100)); continue; }
   const r = await timed(() => pollOnce(db, seal, op, POLL), pollMs);
   if (r.outcome === 'polled') polls++; else deferred++;
  }
 };
 await Promise.all(Array.from({ length: WORKERS }, (_, i) => lane(i)));
 const workerCalls = mock.state.calls.es + mock.state.calls.kibana - callsBefore;
 const health = await fleetHealth(db, apps, POLL);
 const stale = health.filter(h => h.state === 'stale' || h.reason === 'not_polled_yet').length;
 // How far behind schedule the queue is: the oldest due poll that has not started.
 const lag = Number((await db.query(`SELECT coalesce(extract(epoch FROM max(now() - not_before)), 0) AS s FROM integration_operations WHERE state = 'pending' AND not_before < now()`)).rows[0].s);
 const needed = Math.ceil(APPS / POLL);
 results.push(['Apps · workers · poll interval', `${APPS} · ${WORKERS} · ${POLL} s (simulated ${LATENCY} ms per Elastic request)`]);
 results.push(['Polls completed', `${polls} in ${SECONDS} s (${(polls / SECONDS).toFixed(1)}/s; ${needed}/s needed), ${deferred} deferred`]);
 results.push(['Poll duration p50 / p95 / max', `${pct(pollMs, 50)} / ${pct(pollMs, 95)} / ${pct(pollMs, 100)} ms`]);
 results.push(['Elastic requests per poll', (workerCalls / Math.max(polls, 1)).toFixed(1)]);
 // Polls are scheduled, so throughput matches demand when there is headroom; capacity is workers / p95 duration.
 const capacity = WORKERS * 1000 / Math.max(pct(pollMs, 95), 1);
 results.push(['Worker capacity at p95 (estimate)', `${capacity.toFixed(0)} polls/s ≈ ${Math.floor(capacity * POLL)} apps at a ${POLL} s poll`]);
 results.push(['Apps stale or never polled at the end', `${stale} of ${APPS}`]);
 results.push(['Scheduling lag at the end (oldest overdue poll)', `${lag.toFixed(1)} s${lag > POLL ? ' · falling behind: add workers or lengthen the poll' : ''}`]);

 // ── 2. Readers cost Elastic nothing ──
 const readMs: number[] = [];
 const readBefore = mock.state.calls.es + mock.state.calls.kibana;
 // Readers re-read on each invalidation; model a burst where all of them re-read at once.
 await Promise.all(Array.from({ length: READERS }, () => timed(async () => { await fleetHealth(db, apps, POLL); await activeIssues(db, apps.map(a => a.appKey)); }, readMs)));
 const readCalls = mock.state.calls.es + mock.state.calls.kibana - readBefore;
 results.push([`Read models, ${READERS} concurrent readers`, `p50 ${pct(readMs, 50)} ms · p95 ${pct(readMs, 95)} ms · Elastic requests: ${readCalls}`]);

 // ── 3. Customer context at C concurrent agents (the Elastic part; identity is a tenant call) ──
 const client = new ElasticClient({ elasticsearchUrl: mock.esUrl, kibanaUrl: mock.kibanaUrl, spaceId: 'support-ops', apiKey: apiKeyFor(keys[0]), caPem: null }, { allowedHosts: ['127.0.0.1'], production: false });
 const services = [{ name: 'payroll-api', environment: 'production', discriminator: null }, { name: 'payroll-web', environment: 'production', discriminator: null }];
 const now = new Date(); const day = { from: new Date(now.getTime() - 86_400_000), to: now };
 const ctxMs: number[] = [];
 const ctxBefore = mock.state.calls.es;
 await Promise.all(Array.from({ length: AGENTS }, (_, i) => timed(() => Promise.all([
  fetchSubjectEvents(client, 'APM', ['traces-apm-*', 'logs-apm.error-*'], `cust-${(i % 6) + 1}`, services, day),
  fetchSubjectEvents(client, 'RUM', ['traces-apm.rum-*'], `cust-${(i % 6) + 1}`, services, day),
  fetchSynthetics(client, ['synthetics-*'], ['payroll-login', 'payroll-payslip'], { from: new Date(now.getTime() - 900_000), to: now }),
 ]), ctxMs)));
 results.push([`Customer context, ${AGENTS} concurrent agents (uncached)`, `p50 ${pct(ctxMs, 50)} ms · p95 ${pct(ctxMs, 95)} ms · ${mock.state.calls.es - ctxBefore} Elastic requests (3 each; the 60 s cache removes repeats per customer)`]);

 // ── 4. Stream fan-out from one listener ──
 const delays: number[] = []; let delivered = 0;
 // The channel is database-wide (other workers may be running): count only this run's events.
 const mark = `load-${schema.slice(5, 13)}`;
 const unsub = Array.from({ length: SUBSCRIBERS }, () => subscribeObservability(e => { if (e.type === 'health' && e.environment === mark) { delays.push(Date.now() - Date.parse(e.at)); delivered++; } }, () => {}));
 await new Promise(r => setTimeout(r, 1000));
 const EVENTS = 20;
 for (let i = 0; i < EVENTS; i++) { await notifyObservability(db, { type: 'health', appKey: 'payroll', environment: mark, at: new Date().toISOString() }); await new Promise(r => setTimeout(r, 50)); }
 await new Promise(r => setTimeout(r, 1000));
 unsub.forEach(u => u());
 results.push([`Invalidations, ${SUBSCRIBERS} open streams × ${EVENTS} events`, `${delivered} of ${SUBSCRIBERS * EVENTS} delivered · p95 ${pct(delays, 95)} ms · max ${pct(delays, 100)} ms · one listener connection`]);
} finally {
 await mock.close();
 await db.end();
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 await admin.end();
}
console.log('| Measure | Result |\n|---|---|\n' + results.map(([k, v]) => `| ${k} | ${v} |`).join('\n'));
process.exit(0);
