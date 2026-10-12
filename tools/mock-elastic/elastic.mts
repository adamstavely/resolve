import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildScenario, VERSION, type Scenario } from './data.mjs';
import { DslError, search, wildcard, type Doc } from './query.mjs';

/*
 * Development-only mock of Elastic Cloud Hosted 9.x for the endpoints Resolve uses (plan 14, E0):
 * Elasticsearch `GET /`, `POST /{index}/_search` (and point-in-time open/close), Kibana `GET /api/status`,
 * SLO get/find and Cases find. API keys carry index privileges and Kibana space/feature privileges, enforced with
 * Elasticsearch's semantics: wildcards expand only to authorized indices; a named unauthorized index is a 403.
 * Faults (slow, 429, 503, revoked key, late documents) are injected through /dev routes for tests.
 */

export interface MockKey { id: string; secret: string; indices: string[]; spaces: string[]; features: string[]; revoked?: boolean; description?: string }
export interface Fault { kind: 'none' | 'slow' | 'rate_limit' | 'unavailable'; ms?: number; count?: number; retryAfter?: number }

export interface MockElastic {
 esUrl: string; kibanaUrl: string;
 state: { scenario: Scenario; keys: MockKey[]; fault: Fault; calls: { es: number; kibana: number } };
 reset(now?: number): void;
 close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
 res.writeHead(status, { 'Content-Type': 'application/json', 'X-elastic-product': 'Elasticsearch', ...headers });
 res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage, limit = 1_048_576) {
 let raw = '';
 for await (const c of req) { raw += c; if (raw.length > limit) throw new Error('Body too large'); }
 return raw;
}
const esError = (res: ServerResponse, status: number, type: string, reason: string) => send(res, status, { error: { root_cause: [{ type, reason }], type, reason }, status });
const kbError = (res: ServerResponse, status: number, error: string, message: string) => send(res, status, { statusCode: status, error, message });
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startMockElastic(opts: { esPort?: number; kibanaPort?: number; keys: MockKey[]; now?: number }): Promise<MockElastic> {
 const state: MockElastic['state'] = { scenario: buildScenario(opts.now), keys: opts.keys.map(k => ({ ...k })), fault: { kind: 'none' }, calls: { es: 0, kibana: 0 } };
 const pits = new Map<string, { docs: Map<string, Doc[]>; expires: number; key: string }>();

 const authenticate = (req: IncomingMessage): MockKey | null => {
  const m = req.headers.authorization?.match(/^ApiKey ([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const [id, secret] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  const key = state.keys.find(k => k.id === id);
  return key && !key.revoked && secret && safeEqual(secret, key.secret) ? key : null;
 };

 /** Apply the active fault. Returns true when a response was already sent. */
 const faulted = async (res: ServerResponse) => {
  const f = state.fault;
  if (f.kind === 'slow') await new Promise(r => setTimeout(r, f.ms ?? 3000));
  if (f.kind === 'unavailable') { esError(res, 503, 'unavailable_shards_exception', 'mock: unavailable'); return true; }
  if (f.kind === 'rate_limit' && (f.count ?? 1) > 0) {
   f.count = (f.count ?? 1) - 1;
   if (f.count <= 0) state.fault = { kind: 'none' };
   send(res, 429, { error: { type: 'es_rejected_execution_exception', reason: 'mock: rate limited' }, status: 429 }, { 'Retry-After': String(f.retryAfter ?? 2) });
   return true;
  }
  return false;
 };

 const authorized = (key: MockKey, index: string) => key.indices.some(p => wildcard(p, index));

 /** Resolve an index expression with Elasticsearch semantics for this key. */
 function resolveIndices(key: MockKey, expr: string, params: URLSearchParams, source: Map<string, Doc[]>): { names: string[] } | { status: number; type: string; reason: string } {
  const names = new Set<string>();
  for (const part of expr.split(',').map(decodeURIComponent)) {
   if (part.includes('*')) {
    for (const name of source.keys()) if (wildcard(part, name) && authorized(key, name) && (!name.startsWith('.') || part.startsWith('.'))) names.add(name);
   } else {
    if (!authorized(key, part)) return { status: 403, type: 'security_exception', reason: `action [indices:data/read/search] is unauthorized for API key id [${key.id}] on indices [${part}]` };
    if (!source.has(part)) { if (params.get('ignore_unavailable') === 'true') continue; return { status: 404, type: 'index_not_found_exception', reason: `no such index [${part}]` }; }
    names.add(part);
   }
  }
  if (names.size === 0 && params.get('allow_no_indices') === 'false') return { status: 404, type: 'index_not_found_exception', reason: `no such index [${expr}]` };
  return { names: [...names] };
 }

 const es = createServer(async (req, res) => {
  try {
   const url = new URL(req.url ?? '/', 'http://x');
   // Development controls (tests).
   if (url.pathname.startsWith('/dev/')) return devRoute(req, res, url);
   state.calls.es++;
   if (await faulted(res)) return;
   const key = authenticate(req);
   if (!key) return send(res, 401, { error: { type: 'security_exception', reason: 'unable to authenticate with provided credentials and anonymous access is not allowed for this request' }, status: 401 }, { 'WWW-Authenticate': 'ApiKey' });
   if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { name: 'mock-es', cluster_name: 'resolve-mock', version: { ...VERSION, lucene_version: '10.2.0' }, tagline: 'You Know, for Search' });
   if (req.method === 'DELETE' && url.pathname === '/_pit') {
    const body = JSON.parse(await readBody(req) || '{}');
    return send(res, 200, { succeeded: pits.delete(String(body.id)), num_freed: 1 });
   }
   const pitOpen = url.pathname.match(/^\/([^/]+)\/_pit$/);
   if (req.method === 'POST' && pitOpen) {
    const r = resolveIndices(key, pitOpen[1], url.searchParams, state.scenario.indices);
    if ('status' in r) return esError(res, r.status, r.type, r.reason);
    const id = Buffer.from(`pit:${Date.now()}:${Math.random()}`).toString('base64');
    // A point in time keeps the documents as they were when it opened.
    pits.set(id, { docs: new Map(r.names.map(n => [n, [...(state.scenario.indices.get(n) ?? [])]])), expires: Date.now() + 60_000, key: key.id });
    return send(res, 200, { id });
   }
   const searchPath = url.pathname.match(/^\/(?:([^/]+)\/)?_search$/);
   if ((req.method === 'POST' || req.method === 'GET') && searchPath) {
    const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
    let docs: Doc[];
    if (body.pit) {
     const pit = pits.get(String((body.pit as { id?: string }).id));
     if (!pit || pit.expires < Date.now() || pit.key !== key.id) return esError(res, 404, 'search_context_missing_exception', 'No search context found for id');
     docs = [...pit.docs.values()].flat();
     const { pit: _p, ...rest } = body;
     const out = search(docs, rest);
     return send(res, 200, { ...out, pit_id: (body.pit as { id: string }).id });
    }
    if (!searchPath[1]) return esError(res, 400, 'action_request_validation_exception', 'mock: name an index');
    const r = resolveIndices(key, searchPath[1], url.searchParams, state.scenario.indices);
    if ('status' in r) return esError(res, r.status, r.type, r.reason);
    docs = r.names.flatMap(n => state.scenario.indices.get(n) ?? []);
    return send(res, 200, search(docs, body));
   }
   esError(res, 404, 'resource_not_found_exception', `mock: no handler for ${req.method} ${url.pathname}`);
  } catch (e) {
   if (e instanceof DslError) return esError(res, 400, e.type, e.message);
   if (e instanceof SyntaxError) return esError(res, 400, 'parse_exception', 'request body is not valid JSON');
   esError(res, 500, 'exception', e instanceof Error ? e.message : 'unknown');
  }
 });

 const kibana = createServer(async (req, res) => {
  try {
   const url = new URL(req.url ?? '/', 'http://x');
   state.calls.kibana++;
   if (await faulted(res)) return;
   const key = authenticate(req);
   if (!key) return kbError(res, 401, 'Unauthorized', 'Unable to authenticate');
   if (req.method !== 'GET') return kbError(res, 405, 'Method Not Allowed', 'mock: read-only');
   if (url.pathname === '/api/status') return send(res, 200, { name: 'mock-kibana', version: { number: VERSION.number, build_flavor: VERSION.build_flavor, build_snapshot: false }, status: { overall: { level: 'available' } } });
   const spaced = url.pathname.match(/^(?:\/s\/([a-z0-9_-]+))?(\/api\/.*)$/);
   if (!spaced) return kbError(res, 404, 'Not Found', 'Not Found');
   const space = spaced[1] ?? 'default'; const path = spaced[2];
   const feature = path.startsWith('/api/observability/slos') ? 'slo' : path.startsWith('/api/cases') ? 'cases' : null;
   if (!feature) return kbError(res, 404, 'Not Found', 'Not Found');
   if (!key.spaces.includes(space) || !key.features.includes(feature)) return kbError(res, 403, 'Forbidden', `API key [${key.id}] is not authorized for [${feature}] in space [${space}]`);
   if (feature === 'slo') {
    const one = path.match(/^\/api\/observability\/slos\/([A-Za-z0-9_-]+)$/);
    const inSpace = state.scenario.slos.filter(s => s.space === space);
    if (one) {
     const s = inSpace.find(x => x.id === one[1]);
     if (!s) return kbError(res, 404, 'Not Found', `SLO [${one[1]}] not found`);
     const { space: _s, ...dto } = s;
     return send(res, 200, dto);
    }
    if (path === '/api/observability/slos') {
     const perPage = Math.min(Number(url.searchParams.get('perPage') ?? 25), 100);
     return send(res, 200, { page: 1, perPage, total: inSpace.length, results: inSpace.slice(0, perPage).map(({ space: _s, ...dto }) => dto) });
    }
   }
   if (feature === 'cases' && path === '/api/cases/_find') {
    const tags = url.searchParams.getAll('tags'); const statuses = url.searchParams.getAll('status'); const owner = url.searchParams.get('owner');
    const list = state.scenario.cases.filter(c => c.space === space && (!tags.length || c.tags.some(t => tags.includes(t))) && (!statuses.length || statuses.includes(c.status)) && (!owner || c.owner === owner));
    const perPage = Math.min(Number(url.searchParams.get('perPage') ?? 20), 100);
    return send(res, 200, { cases: list.slice(0, perPage).map(({ space: _s, ...c }) => c), page: 1, per_page: perPage, total: list.length, count_open_cases: list.filter(c => c.status === 'open').length });
   }
   kbError(res, 404, 'Not Found', 'Not Found');
  } catch (e) { kbError(res, 500, 'Internal Server Error', e instanceof Error ? e.message : 'unknown'); }
 });

 async function devRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (process.env.NODE_ENV === 'production') return send(res, 404, {});
  const body = req.method === 'POST' ? JSON.parse(await readBody(req) || '{}') : {};
  switch (url.pathname) {
   case '/dev/fault': state.fault = { kind: body.kind ?? 'none', ms: body.ms, count: body.count, retryAfter: body.retryAfter }; return send(res, 200, state.fault);
   case '/dev/keys': {
    const k = state.keys.find(x => x.id === body.id);
    if (!k) return send(res, 404, { error: 'unknown key' });
    if (typeof body.revoked === 'boolean') k.revoked = body.revoked;
    return send(res, 200, { id: k.id, revoked: !!k.revoked });
   }
   case '/dev/ingest': {
    const list = state.scenario.indices.get(String(body.index)) ?? [];
    for (const [i, source] of (body.docs as Record<string, unknown>[]).entries()) list.push({ _id: `ingest-${Date.now()}-${i}`, _index: String(body.index), source });
    state.scenario.indices.set(String(body.index), list);
    return send(res, 200, { index: body.index, count: list.length });
   }
   case '/dev/reset': mock.reset(); return send(res, 200, { ok: true });
   case '/dev/state': return send(res, 200, { fault: state.fault, calls: state.calls, keys: state.keys.map(k => ({ id: k.id, revoked: !!k.revoked })), indices: Object.fromEntries([...state.scenario.indices].map(([k, v]) => [k, v.length])) });
   default: return send(res, 404, { error: 'not_found' });
  }
 }

 const listen = (s: Server, port: number) => new Promise<string>(r => s.listen(port, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
 const esUrl = await listen(es, opts.esPort ?? 0);
 const kibanaUrl = await listen(kibana, opts.kibanaPort ?? 0);
 const mock: MockElastic = {
  esUrl, kibanaUrl, state,
  reset(now) {
   state.scenario = buildScenario(now); state.fault = { kind: 'none' }; state.calls = { es: 0, kibana: 0 }; pits.clear();
   state.keys = opts.keys.map(k => ({ ...k }));
  },
  close: () => Promise.all([new Promise<void>(r => es.close(() => r())), new Promise<void>(r => kibana.close(() => r()))]).then(() => undefined),
 };
 return mock;
}

export const apiKeyFor = (k: Pick<MockKey, 'id' | 'secret'>) => Buffer.from(`${k.id}:${k.secret}`).toString('base64');
