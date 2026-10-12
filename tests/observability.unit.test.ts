import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ElasticAppMapping, SloResult } from '../packages/contracts/src';
import { ElasticClient } from '../apps/api/lib/integrations/elastic/client';
import { fetchAffectedSubjects, fetchAlerts, fetchRecentRuns, fetchSlos, fetchSynthetics } from '../apps/api/lib/integrations/elastic/families';
import { aggregate, sloComponent, withStaleness } from '../apps/api/lib/integrations/elastic/health';
import { runIsolation, runPreview } from '../apps/api/lib/integrations/mappings';
import { apiKeyFor, startMockElastic, type MockElastic, type MockKey } from '../tools/mock-elastic/elastic.mts';

const keys: MockKey[] = JSON.parse(readFileSync(new URL('../tools/mock-elastic/keys.json', import.meta.url), 'utf8')).keys;
let mock: MockElastic;
const client = (keyId = 'resolve-reader') => new ElasticClient({ elasticsearchUrl: mock.esUrl, kibanaUrl: mock.kibanaUrl, spaceId: 'support-ops', apiKey: apiKeyFor(keys.find(k => k.id === keyId)!), caPem: null }, { allowedHosts: ['127.0.0.1'], production: false });
beforeAll(async () => { mock = await startMockElastic({ keys }); });
afterAll(async () => { await mock.close(); });
beforeEach(() => mock.reset());

const CONN = '00000000-0000-4000-8000-000000000001';
export const payroll: ElasticAppMapping = {
 appKey: 'payroll', environment: 'production', connectionId: CONN,
 indices: { apm: ['traces-apm-*', 'logs-apm.error-*'], rum: ['traces-apm.rum-*'], logs: ['logs-payroll-*'], synthetics: ['synthetics-*'] },
 services: [{ name: 'payroll-api', environment: 'production', discriminator: null }, { name: 'payroll-web', environment: 'production', discriminator: null },
  { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'payroll' } }],
 sloIds: ['payroll-payslip-availability', 'payroll-login-latency'], monitorIds: ['payroll-login', 'payroll-payslip'], alertRuleIds: ['payroll-api-5xx-eu-west'], caseTags: ['app:payroll'],
 deepLinkBase: null, subjectPolicy: 'verified_external_id',
};
export const hr: ElasticAppMapping = {
 ...payroll, appKey: 'hr', indices: { ...payroll.indices, logs: [] },
 services: [{ name: 'hr-api', environment: 'production', discriminator: null }, { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'hr' } }],
 sloIds: ['hr-availability'], monitorIds: ['hr-login'], alertRuleIds: ['hr-api-errors'], caseTags: ['app:hr'],
};
const slo = (status: SloResult['status'], extra: Partial<SloResult> = {}): SloResult => ({ sloId: 's', name: 'S', target: 0.995, window: { duration: '30d', type: 'rolling' }, status, sliValue: 0.996, errorBudgetRemaining: 0.2, burnRate: null, ...extra });

describe('health aggregation (no data is never healthy)', () => {
 test('the mock payroll scenario is degraded, with facts for each source', async () => {
  const w = { from: new Date(Date.now() - 24 * 3600_000), to: new Date() };
  const slos = await fetchSlos(client(), payroll.sloIds);
  const alerts = await fetchAlerts(client(), payroll.alertRuleIds, w);
  const syn = await fetchSynthetics(client(), ['synthetics-*'], payroll.monitorIds, { from: new Date(Date.now() - 15 * 60_000), to: new Date() });
  const h = aggregate({ slos: { ok: true, items: slos.items }, alerts: { ok: true, items: alerts.items }, synthetics: { ok: true, items: syn.items, configured: payroll.monitorIds } });
  expect(h).toMatchObject({ state: 'degraded', completeness: 'complete', missing: [] });
  expect(h.summary).toMatchObject({ activeAlerts: 1, synthetics: { passing: 3, total: 4, failing: ['Download payslip (eu-west)'] },
   slos: { total: 2, degrading: 1, healthy: 1, worstBurn: { sloId: 'payroll-payslip-availability', value: 4.2, window: '1h' } } });
  expect(h.components.find(c => c.key === 'payroll-payslip-availability')?.detail).toBe('99.61% against 99.5% (30d rolling), 22% of budget left, burning 4.2x over 1h');
 });
 test('violated is critical; healthy only when something healthy is known', () => {
  expect(aggregate({ slos: { ok: true, items: [slo('violated'), slo('healthy')] } }).state).toBe('critical');
  expect(aggregate({ slos: { ok: true, items: [slo('healthy')] } }).state).toBe('healthy');
  expect(aggregate({ slos: { ok: true, items: [slo('no_data', { sliValue: null })] } }).state).toBe('unknown');
  expect(aggregate({}).state).toBe('unknown');
 });
 test('missing SLOs and monitors without a result are unknown components, not passes', () => {
  const h = aggregate({ slos: { ok: true, items: [slo('healthy')], missingIds: ['gone'] }, synthetics: { ok: true, items: [], configured: ['never-ran'] } });
  expect(h.components.filter(c => c.state === 'unknown').map(c => c.key)).toEqual(['gone', 'never-ran@-']);
  expect(h.state).toBe('healthy');
  expect(sloComponent(slo('no_data', { sliValue: null })).detail).toBe('No data in the 30d rolling window');
 });
 test('a failed family makes it partial and is named; all failed is unavailable and unknown', () => {
  const partial = aggregate({ slos: { ok: true, items: [slo('degrading')] }, alerts: { ok: false, code: 'TIMEOUT' }, others: { cases: { ok: false, code: 'FORBIDDEN' } } });
  expect(partial).toMatchObject({ state: 'degraded', completeness: 'partial', missing: ['alerts', 'cases'] });
  const none = aggregate({ slos: { ok: false, code: 'UNREACHABLE' }, alerts: { ok: false, code: 'UNREACHABLE' } });
  expect(none).toMatchObject({ state: 'unknown', completeness: 'unavailable' });
 });
 test('a snapshot older than two missed polls is stale, whatever it said', () => {
  const now = Date.now();
  expect(withStaleness({ state: 'healthy', fetchedAt: new Date(now - 50_000) }, 30, now).state).toBe('healthy');
  expect(withStaleness({ state: 'critical', fetchedAt: new Date(now - 70_000) }, 30, now).state).toBe('stale');
 });
});

describe('synthetic run strip', () => {
 test('the latest executed runs across the mapped monitors, newest first; aggregation keeps 12, oldest first', async () => {
  const runs = await fetchRecentRuns(client(), ['synthetics-*'], payroll.monitorIds, { from: new Date(Date.now() - 3600_000), to: new Date() });
  expect(runs.items).toHaveLength(12);
  expect(runs.items.filter(r => r.status === 'down').every(r => r.monitorId === 'payroll-payslip' && r.location === 'eu-west')).toBe(true);
  const h = aggregate({ synthetics: { ok: true, items: [], configured: ['payroll-login'], recent: runs.items } });
  expect(h.summary.synthetics.recent.map(r => r.checkedAt)).toEqual([...h.summary.synthetics.recent.map(r => r.checkedAt)].sort());
  expect(h.summary.synthetics).toMatchObject({ configured: 1, total: 0 });
 });
});

describe('known issues', () => {
 test('affected subjects: distinct instrumented subjects with errors on the mapped services since the issue began', async () => {
  const since = new Date(Date.now() - 25 * 60_000);
  // 17 anonymous instrumented subjects plus cust-1; hr's services are not counted.
  expect(await fetchAffectedSubjects(client(), payroll.indices.apm, payroll.services, since)).toBe(18);
  expect(await fetchAffectedSubjects(client(), hr.indices.apm, hr.services, since)).toBe(0);
 });
});

describe('mapping preview and isolation', () => {
 test('preview: payroll resolves every id; an unknown SLO or a monitor that never ran fails it', async () => {
  const ok = await runPreview(client(), payroll, 'cust-1');
  expect(ok.passed).toBe(true);
  expect(Object.fromEntries(ok.families.map(f => [f.family, f.status]))).toEqual({ slo: 'ok', alerts: 'ok', synthetics: 'ok', apm: 'ok', rum: 'ok', logs: 'ok', cases: 'ok' });
  expect(ok.testSubjectEvents).toBeGreaterThan(0);
  const bad = await runPreview(client(), { ...payroll, sloIds: [...payroll.sloIds, 'no-such-slo'], monitorIds: [...payroll.monitorIds, 'hr-leave'] });
  expect(bad.passed).toBe(false);
  expect(bad.families.find(f => f.family === 'slo')).toMatchObject({ status: 'missing', missingIds: ['no-such-slo'] });
 });
 test('preview with a narrow key reports denied sources and does not pass', async () => {
  const r = await runPreview(client('resolve-narrow'), payroll);
  expect(r.passed).toBe(false);
  expect(r.families.find(f => f.family === 'slo')?.status).toBe('denied');
 });
 test('isolation: payroll and hr share a service but not events when each names its discriminator', async () => {
  expect((await runIsolation(client(), payroll, [hr])).passed).toBe(true);
 });
 test('isolation fails when a shared service has no discriminator, or an id is claimed twice', async () => {
  const careless = { ...hr, services: [{ name: 'notification-service', environment: 'production', discriminator: null }] };
  const r = await runIsolation(client(), payroll, [careless]);
  expect(r.passed).toBe(false);
  expect(r.comparedWith[0].overlappingEvents).toBeGreaterThan(0);
  const greedy = await runIsolation(client(), payroll, [{ ...hr, sloIds: ['payroll-login-latency'] }]);
  expect(greedy.comparedWith[0].sharedIds).toEqual(['SLO payroll-login-latency']);
  expect((await runIsolation(client(), payroll, [])).passed).toBe(true);
 });
});

describe('customer context (E2)', () => {
 const issue = (over: Partial<import('../packages/contracts/src').KnownIssue> = {}): import('../packages/contracts/src').KnownIssue => ({
  id: '00000000-0000-4000-8000-0000000000aa', appKey: 'payroll', environment: 'production', kind: 'alert', providerId: 'a1', title: 'payroll-api 5xx',
  state: 'active', since: new Date(Date.now() - 25 * 60_000).toISOString(), lastSeenAt: new Date().toISOString(), service: 'payroll-api', affected: null, linkedTickets: 0, ...over,
 });
 const ev = (minutesAgo: number, service = 'payroll-api', kind: 'error' | 'transaction' = 'error') => ({
  at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), source: 'APM' as const, kind, service, name: 'x', outcome: 'failure' as const, httpStatus: 502, durationMs: null, traceId: 't', transactionId: null, region: null,
 });
 test("an issue matches on service and time; time overlap alone is stated, never called a cause", async () => {
  const { matchIssues } = await import('../apps/api/lib/integrations/subject');
  const [m] = matchIssues([issue()], [ev(12), ev(14), ev(60), ev(5, 'notification-service')], true);
  expect(m).toMatchObject({ customerErrorsInWindow: 2, matched: ['Same application', 'Service payroll-api', "2 of this customer's errors since it began"], missing: [] });
  const [none] = matchIssues([issue()], [ev(60)], true);
  expect(none.missing).toEqual(['No errors from this customer since it began']);
  const [unverified] = matchIssues([issue({ kind: 'case', service: null })], [], false);
  expect(unverified.missing).toEqual(['The source does not name a service', "This customer's own errors (the application did not identify them)"]);
 });
});

describe('evidence snapshots (E2)', () => {
 test('a viewer without the investigator role sees restricted items counted, not shown; the hash is re-verified', async () => {
  const { snapshotView } = await import('../apps/api/lib/integrations/evidence');
  const { canonicalJson } = await import('../packages/contracts/src');
  const { createHash } = await import('node:crypto');
  const facts = { health: null, issues: [], events: [], lastSession: null, synthetics: [], alreadyTried: [],
   restricted: { logs: [{ at: new Date().toISOString(), level: 'error', service: 'payroll-api', message: 'upstream reset', traceId: null }], traces: [{ traceId: 'abc', transactionId: null, at: new Date().toISOString() }] } };
  const row = {
   id: '00000000-0000-4000-8000-0000000000bb', previous_id: null, app_key: 'payroll', environment: 'production', object_kind: 'ticket' as const, object_id: 't1', subject_ref: null,
   requested_from: new Date(), requested_to: new Date(), facts: { ...facts, subjectStatus: 'verified' as const }, completeness: 'complete' as const, classification: 'restricted' as const,
   content_hash: createHash('sha256').update(canonicalJson(facts)).digest('hex'), created_by: 'u', captured_at: new Date(), expires_at: new Date(), note_operation_key: null, note_state: null, display_name: 'Ivy',
  };
  const investigator = snapshotView(row, true);
  expect(investigator).toMatchObject({ hashVerified: true, hiddenRestricted: 0 });
  expect(investigator.facts.restricted.logs).toHaveLength(1);
  const agent = snapshotView(row, false);
  expect(agent).toMatchObject({ hashVerified: true, hiddenRestricted: 2, subjectStatus: 'verified' });
  expect(agent.facts.restricted).toEqual({ logs: [], traces: [] });
  // Tampering with stored facts is detected on view.
  expect(snapshotView({ ...row, facts: { ...row.facts, events: [{ ...facts.restricted.traces[0] } as never] } }, true).hashVerified).toBe(false);
 });
});

describe('pre-flight policy (E3)', () => {
 const health = (state: 'healthy' | 'degraded' | 'unknown', reason: null | 'not_configured' = null) => ({
  appKey: 'payroll', environment: 'production', state, reason, provenance: null, components: [],
  summary: { slos: { total: 1, healthy: 0, degrading: 1, violated: 0, noData: 0, worstBurn: { sloId: 's', name: 'Payslips', target: 0.995, window: '1h', value: 4.2 } }, activeAlerts: 1,
   synthetics: { passing: 3, total: 4, failing: ['Download payslip (eu-west)'], configured: 2, recent: [] } },
 }) as never;
 const ctx = (status: 'verified' | 'unverified', errors: number) => ({
  subject: { status, externalId: status === 'verified' ? 'cust-1' : null },
  matchedIssues: [{ issueId: '00000000-0000-4000-8000-0000000000cc', title: 'Payslips failing', kind: 'case', providerId: 'case-1', since: new Date().toISOString(), matched: [], missing: [], customerErrorsInWindow: errors }],
  synthetics: [{ monitorId: 'm', name: 'Download payslip', location: 'eu-west', status: 'down', durationMs: null, checkedAt: new Date().toISOString() }],
 }) as never;
 test('a known issue touching this customer warns, suggests linking, and may be overridden; it never blocks a low-impact close', async () => {
  const { decide } = await import('../apps/api/lib/integrations/preflight');
  const d = decide('ticket.close', health('degraded'), ctx('verified', 2));
  expect(d.outcome).toBe('warn');
  expect(d.suggestedIssue).toMatchObject({ providerId: 'case-1' });
  expect(d.checks.map(c => c.state)).toEqual(['bad', 'warn', 'warn']);
 });
 test('no issue touching this customer allows; unknown health or an unidentified customer is "unknown", which a low-impact action may proceed on', async () => {
  const { decide } = await import('../apps/api/lib/integrations/preflight');
  expect(decide('ticket.close', health('degraded'), ctx('verified', 0)).outcome).toBe('allow');
  expect(decide('conversation.close', health('unknown', 'not_configured'), ctx('verified', 0)).outcome).toBe('unknown');
  const u = decide('ticket.close', health('degraded'), ctx('unverified', 0));
  expect(u.outcome).toBe('unknown');
  expect(u.checks[1]).toMatchObject({ state: 'unknown' });
 });
});
