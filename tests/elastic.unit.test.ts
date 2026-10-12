import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
 BUNDLES, ELASTIC_FAMILIES, capabilitiesFor, customerIdentityResult, elasticAppMappingSchema, elasticConnectionCreateSchema,
 type ElasticAppMapping,
} from '../packages/contracts/src';
import { addressAllowed, checkOrigin, ElasticClient, ElasticError, hostAllowed } from '../apps/api/lib/integrations/elastic/client';
import {
 ALERT_INDEX, fetchAlerts, fetchCases, fetchSlos, fetchSubjectEvents, fetchSynthetics, parseAlert, parseCase, parseSlo, parseSubjectEvent,
 parseSyntheticsAggs, probeFamily, subjectQuery, versions,
} from '../apps/api/lib/integrations/elastic/families';
import { redactText, safeId } from '../apps/api/lib/integrations/elastic/redact';
import { apiKeyFor, startMockElastic, type MockElastic, type MockKey } from '../tools/mock-elastic/elastic.mts';
import { buildTenant, callTool } from '../tools/mock-tenant/fixtures.mts';

const keys: MockKey[] = JSON.parse(readFileSync(new URL('../tools/mock-elastic/keys.json', import.meta.url), 'utf8')).keys;
const policy = { allowedHosts: ['127.0.0.1'], production: false };
let mock: MockElastic;
const client = (keyId = 'resolve-reader', opts: Partial<typeof policy & { timeoutMs: number; maxBytes: number }> = {}) =>
 new ElasticClient({ elasticsearchUrl: mock.esUrl, kibanaUrl: mock.kibanaUrl, spaceId: 'support-ops', apiKey: apiKeyFor(keys.find(k => k.id === keyId)!), caPem: null }, { ...policy, ...opts });
const day = () => ({ from: new Date(Date.now() - 24 * 3600_000), to: new Date() });
const code = async (p: Promise<unknown>) => { try { await p; return 'none'; } catch (e) { return e instanceof ElasticError ? e.code : String(e); } };

const payroll: ElasticAppMapping['services'] = [
 { name: 'payroll-api', environment: 'production', discriminator: null },
 { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'payroll' } },
];
const hr: ElasticAppMapping['services'] = [
 { name: 'hr-api', environment: 'production', discriminator: null },
 { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'hr' } },
];
const APM = ['traces-apm-*', 'logs-apm.error-*'];

beforeAll(async () => { mock = await startMockElastic({ keys }); });
afterAll(async () => { await mock.close(); });
beforeEach(() => mock.reset());

describe('client safety (plan 12 §4)', () => {
 test('never connects to link-local, metadata, multicast or unspecified addresses; loopback only outside production', () => {
  for (const a of ['169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'fe80::1', '::', '::ffff:169.254.169.254']) expect(addressAllowed(a, true), a).toBe(false);
  for (const a of ['10.20.0.5', '172.16.4.4', '192.168.1.9', 'fd00::5']) expect(addressAllowed(a, false), a).toBe(true);
  expect(addressAllowed('127.0.0.1', false)).toBe(false);
  expect(addressAllowed('127.0.0.1', true)).toBe(true);
  expect(addressAllowed('::1', false)).toBe(false);
 });
 test('hosts must be approved; subdomain rules need a real subdomain', () => {
  expect(hostAllowed('es.obs.corp.internal', ['*.corp.internal'])).toBe(true);
  expect(hostAllowed('corp.internal', ['*.corp.internal'])).toBe(false);
  expect(hostAllowed('evilcorp.internal', ['*.corp.internal'])).toBe(false);
  expect(hostAllowed('es.example.com', [])).toBe(false);
 });
 test('https only (plain http for a loopback mock outside production); no credentials in the URL', () => {
  const p = { allowedHosts: ['es.corp.internal', '127.0.0.1'], production: true };
  expect(() => checkOrigin('http://es.corp.internal', p)).toThrow('INSECURE_URL');
  expect(() => checkOrigin('https://user:pw@es.corp.internal', p)).toThrow('INSECURE_URL');
  expect(() => checkOrigin('http://127.0.0.1:3400', p)).toThrow('INSECURE_URL');
  expect(() => checkOrigin('https://es.other.internal', p)).toThrow('HOST_NOT_ALLOWED');
  expect(checkOrigin('https://es.corp.internal:9243', p).host).toBe('es.corp.internal:9243');
  expect(checkOrigin('http://127.0.0.1:3400', { ...p, production: false }).port).toBe('3400');
 });
 test('a connection needs exactly one credential source and approved shapes', () => {
  const base = { name: 'Prod', elasticsearchUrl: 'https://es.corp.internal', kibanaUrl: 'https://kb.corp.internal', spaceId: 'support-ops' };
  expect(elasticConnectionCreateSchema.safeParse({ ...base, apiKey: 'x'.repeat(20) }).success).toBe(true);
  expect(elasticConnectionCreateSchema.safeParse({ ...base, secretRef: 'env:ELASTIC_PROD_KEY' }).success).toBe(true);
  expect(elasticConnectionCreateSchema.safeParse(base).success).toBe(false);
  expect(elasticConnectionCreateSchema.safeParse({ ...base, apiKey: 'x'.repeat(20), secretRef: 'env:ELASTIC_PROD_KEY' }).success).toBe(false);
  expect(elasticConnectionCreateSchema.safeParse({ ...base, spaceId: '../admin', apiKey: 'x'.repeat(20) }).success).toBe(false);
 });
 test('mapping index patterns cannot be broad, hidden or cross-cluster', () => {
  const m = (apm: string[]) => elasticAppMappingSchema.safeParse({
   appKey: 'payroll', environment: 'production', connectionId: '00000000-0000-4000-8000-000000000000', indices: { apm, rum: [], logs: [], synthetics: [] },
   services: payroll, sloIds: [], monitorIds: [], alertRuleIds: [], caseTags: [], deepLinkBase: null, subjectPolicy: 'verified_external_id',
  }).success;
  expect(m(['traces-apm-*'])).toBe(true);
  for (const bad of [['*'], ['.security*'], ['remote:traces-*'], ['-logs-*'], ['**']]) expect(m(bad), bad[0]).toBe(false);
 });
 test('redirects are refused, oversized responses cut off, timeouts bounded', async () => {
  const srv = createServer((req, res) => {
   if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ pad: 'x'.repeat(5000) })); return; }
   if (req.url === '/slow') { setTimeout(() => res.end('{}'), 500); return; }
   res.writeHead(302, { Location: 'http://169.254.169.254/' }); res.end();
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const c = new ElasticClient({ elasticsearchUrl: origin, kibanaUrl: origin, spaceId: 'default', apiKey: 'k', caPem: null }, { ...policy, maxBytes: 1000, timeoutMs: 100 });
  expect(await code(c.es('GET', '/'))).toBe('REDIRECT_REFUSED');
  expect(await code(c.es('GET', '/big'))).toBe('RESPONSE_TOO_LARGE');
  expect(await code(c.es('GET', '/slow'))).toBe('TIMEOUT');
  await new Promise(r => srv.close(r));
 });
 test('429 carries Retry-After; a revoked key is unauthenticated; a host that resolves to metadata is refused', async () => {
  await fetch(`${mock.esUrl}/dev/fault`, { method: 'POST', body: JSON.stringify({ kind: 'rate_limit', count: 1, retryAfter: 7 }) });
  const e = await client().es('GET', '/').catch(x => x as ElasticError);
  expect(e).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 7 });
  expect((await client().es<{ version: { number: string } }>('GET', '/')).body.version.number).toMatch(/^9\./);
  expect(await code(client('resolve-revoked').es('GET', '/'))).toBe('UNAUTHENTICATED');
  const rebinding = new ElasticClient({ elasticsearchUrl: 'http://localhost:1', kibanaUrl: 'http://localhost:1', spaceId: 'default', apiKey: 'k', caPem: null },
   { allowedHosts: ['localhost'], production: false }, (async () => ({ address: '169.254.169.254', family: 4 })) as never);
  expect(await code(rebinding.es('GET', '/'))).toBe('ADDRESS_NOT_ALLOWED');
 });
});

describe('API families against the mock (9.x shapes)', () => {
 test('versions: Elasticsearch and Kibana 9.x, Cloud Hosted flavour', async () => {
  expect(await versions(client())).toEqual({ elasticsearch: { version: '9.1.0', buildFlavor: 'default' }, kibana: { version: '9.1.0', buildFlavor: 'default' } });
 });
 test('SLOs: target, window, status and the 1h burn rate as reported; unknown ids are listed, not invented', async () => {
  const r = await fetchSlos(client(), ['payroll-payslip-availability', 'payroll-login-latency', 'no-such-slo']);
  expect(r.dropped).toBe(0);
  expect(r.missing).toEqual(['no-such-slo']);
  expect(r.items[0]).toMatchObject({ sloId: 'payroll-payslip-availability', target: 0.995, status: 'degrading', burnRate: { window: '1h', value: 4.2 }, window: { duration: '30d', type: 'rolling' } });
  expect(parseSlo({ id: 'x', name: 'x', objective: { target: 0.9 }, timeWindow: { duration: '7d', type: 'rolling' }, summary: { status: 'NO_DATA', sliValue: -1, errorBudget: { remaining: 1 } } }))
   .toMatchObject({ status: 'no_data', sliValue: null, burnRate: null });
 });
 test('alerts: only this space and these rules; reasons are redacted', async () => {
  const r = await fetchAlerts(client(), ['payroll-api-5xx-eu-west'], day());
  expect(r.items).toHaveLength(1);
  expect(r.items[0]).toMatchObject({ ruleId: 'payroll-api-5xx-eu-west', status: 'active', service: 'payroll-api' });
  expect(r.items[0].reason).toContain('token=[redacted]');
  expect(r.items[0].reason).not.toContain('dev-secret');
  expect((await fetchAlerts(client(), [], day())).items).toEqual([]);
 });
 test('synthetics: executed results per monitor and location; a configured monitor that has not run is absent, not "up"', async () => {
  const r = await fetchSynthetics(client(), ['synthetics-*'], ['payroll-payslip', 'payroll-login', 'hr-leave'], { from: new Date(Date.now() - 15 * 60_000), to: new Date() });
  const by = Object.fromEntries(r.items.map(i => [`${i.monitorId}@${i.location}`, i.status]));
  expect(by).toEqual({ 'payroll-payslip@eu-west': 'down', 'payroll-payslip@us-east': 'up', 'payroll-login@eu-west': 'up', 'payroll-login@us-east': 'up' });
 });
 test('cases: open cases by tag; titles only, never descriptions', async () => {
  const r = await fetchCases(client(), ['app:payroll']);
  expect(r.items.map(c => c.caseId)).toEqual(['case-payroll-1182']);
  expect(JSON.stringify(r.items)).not.toContain('7700');
  expect((await fetchCases(client(), ['app:hr'])).items).toEqual([]); // closed
 });
 test('subject events are scoped to the mapping: environment, service and discriminator decide; a service name alone does not', async () => {
  const p = await fetchSubjectEvents(client(), 'APM', APM, 'cust-1', payroll, day());
  expect(p.dropped).toBe(0);
  expect(new Set(p.items.map(e => e.service))).toEqual(new Set(['payroll-api', 'notification-service']));
  expect(p.items.find(e => e.service === 'notification-service')?.outcome).toBe('success'); // payroll's, not hr's failure
  expect(p.items.filter(e => e.kind === 'error')).toHaveLength(2);
  const h = await fetchSubjectEvents(client(), 'APM', APM, 'cust-1', hr, day());
  expect(new Set(h.items.map(e => e.service))).toEqual(new Set(['hr-api', 'notification-service']));
  expect(h.items.find(e => e.service === 'notification-service')?.outcome).toBe('failure');
  expect((await fetchSubjectEvents(client(), 'APM', APM, 'cust-7', payroll, day())).items).toEqual([]);
 });
 test('RUM page loads carry the derived region', async () => {
  const r = await fetchSubjectEvents(client(), 'RUM', ['traces-apm.rum-*'], 'cust-1', [{ name: 'payroll-web', environment: 'production', discriminator: null }], day());
  expect(r.items[0]).toMatchObject({ kind: 'page_load', durationMs: 8400, region: 'Lisbon' });
 });
 test('subject ids are term values, never query syntax', async () => {
  const q = JSON.stringify(subjectQuery('cust-1" OR user.id:*', payroll, day()));
  expect(q).toContain('"user.id":"cust-1\\" OR user.id:*"');
  expect((await fetchSubjectEvents(client(), 'APM', APM, '*', payroll, day())).items).toEqual([]);
 });
});

describe('discovery and negative authorization', () => {
 test('the reader key reaches every family', async () => {
  for (const f of ELASTIC_FAMILIES) expect(await probeFamily(client(), f), f).toEqual({ status: 'supported', code: null });
 });
 test('a narrow key: Kibana families denied, unauthorized data streams not found, its own traces readable', async () => {
  const c = client('resolve-narrow');
  expect(await probeFamily(c, 'slo')).toMatchObject({ status: 'denied' });
  expect(await probeFamily(c, 'cases')).toMatchObject({ status: 'denied' });
  expect(await probeFamily(c, 'alerts')).toMatchObject({ status: 'unsupported', code: 'index_not_found_exception' });
  expect(await probeFamily(c, 'synthetics')).toMatchObject({ status: 'unsupported' });
  expect(await probeFamily(c, 'apm')).toEqual({ status: 'supported', code: null });
  // Naming an index the key may not read is a 403, not an empty result.
  expect(await code(c.es('POST', '/logs-payroll-default/_search', { size: 0 }))).toBe('FORBIDDEN');
  expect(await code(c.es('POST', `/${encodeURIComponent(ALERT_INDEX)}/_search`, { size: 1 }))).toBe('none'); // wildcard: empty, authorized only
 });
 test('a revoked key fails every family as denied', async () => {
  expect(await probeFamily(client('resolve-revoked'), 'apm')).toEqual({ status: 'denied', code: 'UNAUTHENTICATED' });
 });
});

describe('redaction (plan 12 §8)', () => {
 test('credentials, tokens, card numbers, contact details', () => {
  const s = redactText('Authorization: Bearer abcdefghijklmnop token=s3cr3t password: "hunter2" eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz card 4111 1111 1111 1111 order 1234567890123 mail a.b@example.test call +44 7700 900123 AKIAABCDEFGHIJKLMNOP')!;
  for (const leaked of ['abcdefghijklmnop', 's3cr3t', 'hunter2', 'eyJhbGci', '4111', 'a.b@example.test', '7700', 'AKIA']) expect(s, leaked).not.toContain(leaked);
  expect(s).toContain('order 1234567890123'); // not Luhn-valid: not a card
  expect(s).toContain('token=[redacted]');
 });
 test('an already-redacted value is left alone, and surrounding text keeps its spacing', () => {
  expect(redactText('retrying with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz card 4111 1111 1111 1111 for a@b.test'))
   .toBe('retrying with Authorization: [credential] card [card] for [email]');
 });
 test('bounded length and control characters; ids must be simple tokens', () => {
  expect(redactText('a'.repeat(900), 100)).toHaveLength(100);
  expect(redactText('line\u0000\u001b[31mred')).toBe('line[31mred');
  expect(safeId('7f3a9e0c41b2')).toBe('7f3a9e0c41b2');
  expect(safeId('<script>')).toBeNull();
 });
});

describe('recorded fixtures (contract: the adapter parses what Elastic returned)', () => {
 const root = new URL('./fixtures/elastic/', import.meta.url);
 const sources = readdirSync(root);
 test('fixtures exist', () => { expect(sources).toContain('mock'); });
 for (const source of sources) {
  const dir = new URL(`${source}/`, root);
  const load = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')) as { meta: { source: string }; response: { status: number; body: any } };
  const files = readdirSync(dir).map(f => f.replace(/\.json$/, ''));
  test(`${source}: every family parses with nothing dropped`, () => {
   expect(load('version').response.body.version.number).toMatch(/^9\./);
   for (const f of files.filter(f => f.startsWith('slo-') && f !== 'slo-missing')) expect(parseSlo(load(f).response.body), f).toMatchObject({ status: expect.any(String) });
   expect(load('slo-missing').response.status).toBe(404);
   const alerts = load('alerts').response.body.hits.hits.map((h: any) => parseAlert(h.fields));
   expect(alerts.length).toBeGreaterThan(0);
   const synth = parseSyntheticsAggs(load('synthetics').response.body.aggregations);
   expect(synth.length).toBeGreaterThan(0);
   const cases = load('cases').response.body.cases.map(parseCase);
   for (const [name, rows, schema] of [['alerts', alerts, 'alert'], ['synthetics', synth, 'synthetic'], ['cases', cases, 'case']] as const) {
    expect(rows.every((r: any) => Object.values(r).every(v => v !== undefined)), `${name} ${schema}`).toBe(true);
   }
   for (const f of ['apm-subject', 'rum-subject']) {
    const ev = load(f).response.body.hits.hits.map((h: any) => parseSubjectEvent(h.fields, f.startsWith('rum') ? 'RUM' : 'APM'));
    expect(ev.length, f).toBeGreaterThan(0);
    for (const e of ev) expect(e, f).toMatchObject({ at: expect.any(String), service: expect.any(String) });
   }
  });
  test(`${source}: the negative key is refused or sees nothing`, () => {
   for (const f of files.filter(f => f.startsWith('negative-'))) {
    const r = load(f).response;
    expect([401, 403, 404].includes(r.status) || (r.status === 200 && r.body.hits?.hits?.length === 0), f).toBe(true);
   }
  });
  test(`${source}: no secrets or subject ids were recorded`, () => {
   const all = files.map(f => readFileSync(new URL(`${f}.json`, dir), 'utf8')).join('\n');
   for (const leaked of ['dev-secret-123', '7700 900123', 'Internal notes', '"cust-1"', 'jordan@example.test', 'dev-only-mock-elastic']) expect(all, leaked).not.toContain(leaked);
  });
 }
});

describe('customer identity (QB-OBS-1, mock tenant)', () => {
 const data = buildTenant('payroll', 11, { tickets: 40, conversations: 24 }, [{ principalId: 'principal_agent', name: 'Agent' }]);
 const admin = { principalId: 'p_admin', role: 'admin' as const, teams: [], analytics: true };
 const observer = { principalId: 'p_obs', role: 'observer' as const, teams: [], analytics: false };
 test('signed-identify customers have a verified id; others are unverified with no id', () => {
  const verified = data.conversations.find(c => c.visitorPrincipalId === 'principal_customer_1')!;
  const unverified = data.conversations.find(c => c.visitorPrincipalId === 'principal_customer_7')!;
  expect(customerIdentityResult.parse(callTool(data, admin, 'get_customer_identity', { conversationId: verified.id }))).toEqual({ verified: true, externalId: 'cust-1' });
  expect(customerIdentityResult.parse(callTool(data, admin, 'get_customer_identity', { conversationId: unverified.id }))).toEqual({ verified: false, externalId: null });
  const t = data.tickets[0];
  expect(customerIdentityResult.safeParse(callTool(data, admin, 'get_customer_identity', { ticketId: t.id })).success).toBe(true);
 });
 test('same visibility as detail: a conversation the viewer cannot see is not found', () => {
  expect(() => callTool(data, observer, 'get_customer_identity', { conversationId: data.conversations[0].id })).toThrow('Not found');
 });
});

describe('access (owner decision: capabilities, not tiers)', () => {
 test('observers see health only; agents add customer context and linking; investigators add restricted evidence; admins configure', () => {
  const caps = (b: keyof typeof BUNDLES) => [...capabilitiesFor([b])].filter(c => c.startsWith('observability.')).sort();
  expect(caps('fleet-observer')).toEqual(['observability.health']);
  expect(caps('fleet-agent')).toEqual(['observability.health', 'observability.link', 'observability.subject']);
  expect(caps('observability-investigator')).toEqual(['observability.health', 'observability.restricted']);
  expect(caps('fleet-admin')).toContain('observability.configure');
  for (const b of Object.keys(BUNDLES) as (keyof typeof BUNDLES)[]) if (b !== 'fleet-admin') expect(caps(b), b).not.toContain('observability.configure');
 });
});
