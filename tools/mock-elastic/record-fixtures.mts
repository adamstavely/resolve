/*
 * Record the adapter's own Elastic requests and the raw responses as contract fixtures (plan 14, E0).
 *
 *   npm run elastic:fixtures -- --mock        records against an in-process mock (tests/fixtures/elastic/mock)
 *   npm run elastic:fixtures                  records against a real deployment (tests/fixtures/elastic/live)
 *
 * A live run reads ELASTIC_RECORD_ES_URL, ELASTIC_RECORD_KIBANA_URL, ELASTIC_RECORD_SPACE, ELASTIC_RECORD_API_KEY,
 * optional ELASTIC_RECORD_NEGATIVE_API_KEY (a key that must be refused) and ELASTIC_RECORD_MAPPING (a JSON file
 * shaped like an elastic app mapping plus `subject`). Every string in a recorded response is redacted and subject
 * ids are replaced with stable hashes before anything is written: fixtures are committed, telemetry is not.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ElasticClient, ElasticError } from '../../apps/api/lib/integrations/elastic/client';
import { ALERT_INDEX, alertQuery, subjectQuery, syntheticsQuery } from '../../apps/api/lib/integrations/elastic/families';
import { redactText } from '../../apps/api/lib/integrations/elastic/redact';
import { apiKeyFor, startMockElastic, type MockKey } from './elastic.mjs';

interface RecordMapping {
 indices: { apm: string[]; rum: string[]; synthetics: string[] };
 services: { name: string; environment: string; discriminator: { field: 'labels.app' | 'service.namespace'; value: string } | null }[];
 sloIds: string[]; monitorIds: string[]; alertRuleIds: string[]; caseTags: string[]; subject: string;
}

const MOCK_MAPPING: RecordMapping = {
 indices: { apm: ['traces-apm-*', 'logs-apm.error-*'], rum: ['traces-apm.rum-*'], synthetics: ['synthetics-*'] },
 services: [{ name: 'payroll-api', environment: 'production', discriminator: null }, { name: 'payroll-web', environment: 'production', discriminator: null },
  { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'payroll' } }],
 sloIds: ['payroll-payslip-availability', 'payroll-login-latency'], monitorIds: ['payroll-login', 'payroll-payslip'],
 alertRuleIds: ['payroll-api-5xx-eu-west'], caseTags: ['app:payroll'], subject: 'cust-1',
};

const live = !process.argv.includes('--mock');
const env = (n: string) => { const v = process.env[n]; if (!v) throw new Error(`${n} is required for a live recording`); return v; };
let mock: Awaited<ReturnType<typeof startMockElastic>> | null = null;
let target: { es: string; kibana: string; space: string; key: string; negativeKey: string | null; mapping: RecordMapping; allowedHosts: string[] };
if (live) {
 target = {
  es: env('ELASTIC_RECORD_ES_URL'), kibana: env('ELASTIC_RECORD_KIBANA_URL'), space: env('ELASTIC_RECORD_SPACE'), key: env('ELASTIC_RECORD_API_KEY'),
  negativeKey: process.env.ELASTIC_RECORD_NEGATIVE_API_KEY ?? null, mapping: JSON.parse(readFileSync(env('ELASTIC_RECORD_MAPPING'), 'utf8')),
  allowedHosts: (process.env.ELASTIC_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean),
 };
} else {
 const keys: MockKey[] = JSON.parse(readFileSync(new URL('./keys.json', import.meta.url), 'utf8')).keys;
 // A fixed clock keeps recorded mock fixtures stable between runs.
 mock = await startMockElastic({ keys, now: Date.parse('2026-10-12T22:00:00Z') });
 target = { es: mock.esUrl, kibana: mock.kibanaUrl, space: 'support-ops', key: apiKeyFor(keys[0]), negativeKey: apiKeyFor(keys[1]), mapping: MOCK_MAPPING, allowedHosts: ['127.0.0.1'] };
}

const policy = { allowedHosts: target.allowedHosts, production: live };
const client = (key: string) => new ElasticClient({ elasticsearchUrl: target.es, kibanaUrl: target.kibana, spaceId: target.space, apiKey: key, caPem: process.env.ELASTIC_RECORD_CA_FILE ? readFileSync(process.env.ELASTIC_RECORD_CA_FILE, 'utf8') : null }, policy);
const c = client(target.key);
const now = live ? new Date() : new Date('2026-10-12T22:00:00Z');
const w = { from: new Date(now.getTime() - 24 * 3600_000), to: now };
const subjectHash = (s: string) => 'subject-' + createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Fields the adapter never reads are not recorded at all (case descriptions and comments can carry anything). */
const NEVER_RECORDED = new Set(['description', 'comments', 'message', 'external_service', 'connector']);
/** Redact every string; replace the subject id everywhere. Mock data is synthetic, but goes through the same path. */
function sanitize(v: unknown): unknown {
 if (typeof v === 'string') return v === target.mapping.subject ? subjectHash(v) : redactText(v, 2000);
 if (Array.isArray(v)) return v.map(sanitize);
 if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !NEVER_RECORDED.has(k)).map(([k, x]) => [k, sanitize(x)]));
 return v;
}

const out = new URL(`../../tests/fixtures/elastic/${live ? 'live' : 'mock'}/`, import.meta.url);
mkdirSync(out, { recursive: true });
let meta: Record<string, unknown> = {};

async function record(name: string, request: { api: 'es' | 'kibana' | 'kibana-root'; method: string; path: string; body?: unknown; query?: Record<string, string | string[]> }, cl = c) {
 let response: { status: number; body: unknown };
 try {
  response = request.api === 'es'
   ? await cl.es(request.method as 'GET' | 'POST', request.path, request.body, request.query)
   : request.api === 'kibana-root' ? await cl.kibanaRoot(request.path) : await cl.kibana(request.path, request.query);
 } catch (e) {
  if (!(e instanceof ElasticError)) throw e;
  response = { status: e.status ?? 0, body: { errorCode: e.code, elasticType: e.elasticType } };
 }
 const fixture = { meta: { ...meta, family: name, recordedAt: live ? new Date().toISOString() : '2026-10-12T22:00:00.000Z' }, request: sanitize(request), response: { status: response.status, body: sanitize(response.body) } };
 writeFileSync(new URL(`${name}.json`, out), JSON.stringify(fixture, null, 1) + '\n');
 console.log(`${name}: ${response.status}`);
}

const es = (await c.es<{ version?: { number?: string; build_flavor?: string } }>('GET', '/')).body;
meta = { source: live ? 'live' : 'mock', elasticsearch: es.version?.number ?? null, buildFlavor: es.version?.build_flavor ?? null };
const m = target.mapping;
const idx = (p: string[]) => '/' + p.map(encodeURIComponent).join(',') + '/_search';

await record('version', { api: 'es', method: 'GET', path: '/' });
await record('kibana-status', { api: 'kibana-root', method: 'GET', path: '/api/status' });
for (const id of m.sloIds) await record(`slo-${id}`, { api: 'kibana', method: 'GET', path: `/api/observability/slos/${encodeURIComponent(id)}` });
await record('slo-missing', { api: 'kibana', method: 'GET', path: '/api/observability/slos/resolve-fixture-no-such-slo' });
await record('alerts', { api: 'es', method: 'POST', path: `/${encodeURIComponent(ALERT_INDEX)}/_search`, body: alertQuery(target.space, m.alertRuleIds, w) });
await record('synthetics', { api: 'es', method: 'POST', path: idx(m.indices.synthetics), body: syntheticsQuery(m.monitorIds, { from: new Date(now.getTime() - 15 * 60_000), to: now }) });
await record('cases', { api: 'kibana', method: 'GET', path: '/api/cases/_find', query: { tags: m.caseTags, status: ['open', 'in-progress'], owner: 'observability', perPage: '50', sortField: 'updatedAt', sortOrder: 'desc' } });
await record('apm-subject', { api: 'es', method: 'POST', path: idx(m.indices.apm), body: subjectQuery(m.subject, m.services, w) });
await record('rum-subject', { api: 'es', method: 'POST', path: idx(m.indices.rum), body: subjectQuery(m.subject, m.services, w) });

// Negative authorization: the same reads with a key that must be refused or see nothing.
if (target.negativeKey) {
 const neg = client(target.negativeKey);
 await record('negative-slo', { api: 'kibana', method: 'GET', path: `/api/observability/slos/${encodeURIComponent(m.sloIds[0] ?? 'x')}` }, neg);
 await record('negative-alerts', { api: 'es', method: 'POST', path: `/${encodeURIComponent(ALERT_INDEX)}/_search`, body: alertQuery(target.space, m.alertRuleIds, w), query: { allow_no_indices: 'false' } }, neg);
 await record('negative-synthetics', { api: 'es', method: 'POST', path: idx(m.indices.synthetics), body: syntheticsQuery(m.monitorIds, w), query: { allow_no_indices: 'false' } }, neg);
 await record('negative-cases', { api: 'kibana', method: 'GET', path: '/api/cases/_find', query: { tags: m.caseTags, owner: 'observability' } }, neg);
}
await mock?.close();
