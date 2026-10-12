import {
 alertResultSchema, caseResultSchema, sloResultSchema, subjectEventSchema, syntheticResultSchema,
 type AlertResult, type CaseResult, type ElasticAppMapping, type ElasticFamily, type FamilyStatus, type SloResult, type SubjectEvent, type SyntheticResult,
} from '@resolve/contracts';
import { ElasticClient, ElasticError } from './client';
import { redactText, safeId } from './redact';

/*
 * One adapter per Elastic API family (plan 12 §3). Each builds a bounded, parameterized query (no user DSL or KQL:
 * values go in as term values, index expressions come from an admin-approved mapping), reads an explicit field list
 * through `fields` (so dotted and nested sources parse the same), and returns Resolve's normalized DTOs. Anything
 * that does not parse is dropped and counted, never guessed.
 */

/** Alert documents (alerts-as-data). The pattern is fixed; the API key's index privileges bound it further. */
export const ALERT_INDEX = '.alerts-observability.*';
/** Discovery probes when no app mapping exists yet. */
export const DEFAULT_PATTERNS: Record<'apm' | 'rum' | 'logs' | 'synthetics', string> = {
 apm: 'traces-apm-*,logs-apm.error-*', rum: 'traces-apm.rum*', logs: 'logs-*', synthetics: 'synthetics-*',
};

export interface Parsed<T> { items: T[]; dropped: number }

type Fields = Record<string, unknown[] | undefined>;
interface SearchBody { hits: { hits: { _id: string; _index: string; fields?: Fields }[] }; aggregations?: Record<string, unknown> }
const first = <T = unknown>(f: Fields | undefined, k: string) => f?.[k]?.[0] as T | undefined;
const iso = (v: unknown) => { const t = typeof v === 'string' || typeof v === 'number' ? Date.parse(String(v)) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };

function keep<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, rows: unknown[]): Parsed<T> {
 const items: T[] = []; let dropped = 0;
 for (const r of rows) { const p = schema.safeParse(r); if (p.success) items.push(p.data); else dropped++; }
 return { items, dropped };
}

/** Time-bounded window; the caller's policy sets the maximum. */
export interface Window { from: Date; to: Date }
const range = (w: Window) => ({ range: { '@timestamp': { gte: w.from.toISOString(), lte: w.to.toISOString(), format: 'strict_date_optional_time' } } });

/** Services as a filter: each selector is name + environment (+ discriminator for shared services). */
export function serviceFilter(services: ElasticAppMapping['services']) {
 return {
  bool: {
   minimum_should_match: 1,
   should: services.map(s => ({
    bool: {
     filter: [
      { term: { 'service.name': s.name } },
      { term: { 'service.environment': s.environment } },
      ...(s.discriminator ? [{ term: { [s.discriminator.field]: s.discriminator.value } }] : []),
     ],
    },
   })),
  },
 };
}

const indexList = (patterns: readonly string[]) => patterns.map(encodeURIComponent).join(',');

// ── SLOs (Kibana) ──

interface KibanaSlo {
 id?: unknown; name?: unknown; objective?: { target?: unknown }; timeWindow?: { duration?: unknown; type?: unknown };
 summary?: { status?: unknown; sliValue?: unknown; errorBudget?: { remaining?: unknown }; oneHourBurnRate?: unknown };
}
export function parseSlo(raw: KibanaSlo): unknown {
 const status = String(raw.summary?.status ?? '').toLowerCase();
 const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
 const burn = num(raw.summary?.oneHourBurnRate);
 return {
  sloId: raw.id, name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : raw.name,
  target: raw.objective?.target,
  window: { duration: raw.timeWindow?.duration, type: raw.timeWindow?.type },
  status: status === 'no_data' ? 'no_data' : status,
  // Elastic reports -1 when there is no data; that is not a value.
  sliValue: num(raw.summary?.sliValue) === -1 ? null : num(raw.summary?.sliValue),
  errorBudgetRemaining: num(raw.summary?.errorBudget?.remaining),
  burnRate: burn === null ? null : { window: '1h', value: burn },
 };
}
export async function fetchSlos(client: ElasticClient, ids: readonly string[]): Promise<Parsed<SloResult> & { missing: string[] }> {
 const missing: string[] = []; const rows: unknown[] = [];
 // Bounded fan-out: SLO ids come from the approved mapping (at most 50).
 for (let i = 0; i < ids.length; i += 5) {
  const batch = await Promise.all(ids.slice(i, i + 5).map(async id => {
   try { return (await client.kibana<KibanaSlo>(`/api/observability/slos/${encodeURIComponent(id)}`)).body; }
   catch (e) { if (e instanceof ElasticError && e.code === 'NOT_FOUND') { missing.push(id); return null; } throw e; }
  }));
  for (const b of batch) if (b) rows.push(parseSlo(b));
 }
 return { ...keep(sloResultSchema, rows), missing };
}

// ── Alerts (alerts-as-data indices) ──

export const ALERT_FIELDS = ['kibana.alert.uuid', 'kibana.alert.rule.uuid', 'kibana.alert.rule.name', 'kibana.alert.status', 'kibana.alert.start', 'kibana.alert.reason', 'service.name', 'service.environment'] as const;
export function alertQuery(spaceId: string, ruleIds: readonly string[], w: Window) {
 return {
  size: 100, track_total_hits: false, _source: false, fields: [...ALERT_FIELDS], sort: [{ 'kibana.alert.start': 'desc' }],
  query: { bool: { filter: [
   { term: { 'kibana.space_ids': spaceId } },
   { terms: { 'kibana.alert.rule.uuid': [...ruleIds] } },
   { bool: { minimum_should_match: 1, should: [{ term: { 'kibana.alert.status': 'active' } }, { range: { 'kibana.alert.start': { gte: w.from.toISOString() } } }] } },
  ] } },
 };
}
export function parseAlert(f: Fields | undefined): unknown {
 return {
  alertId: safeId(first(f, 'kibana.alert.uuid')), ruleId: safeId(first(f, 'kibana.alert.rule.uuid')), ruleName: redactText(first<string>(f, 'kibana.alert.rule.name'), 200),
  status: first(f, 'kibana.alert.status'), startedAt: iso(first(f, 'kibana.alert.start')),
  service: first(f, 'service.name') ?? null, environment: first(f, 'service.environment') ?? null,
  reason: redactText(first<string>(f, 'kibana.alert.reason')),
 };
}
export async function fetchAlerts(client: ElasticClient, ruleIds: readonly string[], w: Window): Promise<Parsed<AlertResult>> {
 if (ruleIds.length === 0) return { items: [], dropped: 0 };
 const r = await client.es<SearchBody>('POST', `/${encodeURIComponent(ALERT_INDEX)}/_search`, alertQuery(client.spaceId, ruleIds, w));
 return keep(alertResultSchema, r.body.hits.hits.map(h => parseAlert(h.fields)));
}

// ── Synthetics (executed results, not monitor configuration) ──

export const SYNTHETIC_FIELDS = ['monitor.id', 'monitor.name', 'monitor.status', 'monitor.duration.us', 'observer.geo.name', '@timestamp'] as const;
export function syntheticsQuery(monitorIds: readonly string[], w: Window) {
 return {
  size: 0, track_total_hits: false,
  query: { bool: { filter: [{ terms: { 'monitor.id': [...monitorIds] } }, { exists: { field: 'summary' } }, range(w)] } },
  aggs: {
   monitors: { terms: { field: 'monitor.id', size: monitorIds.length || 1 }, aggs: {
    locations: { terms: { field: 'observer.geo.name', size: 20 }, aggs: {
     latest: { top_hits: { size: 1, sort: [{ '@timestamp': 'desc' }], _source: false, fields: [...SYNTHETIC_FIELDS] } },
    } },
   } },
  },
 };
}
interface Bucket { key: string; locations?: { buckets: Bucket[] }; latest?: { hits: { hits: { fields?: Fields }[] } } }
export function parseSyntheticsAggs(aggs: Record<string, unknown> | undefined): unknown[] {
 const out: unknown[] = [];
 for (const m of (aggs?.monitors as { buckets?: Bucket[] } | undefined)?.buckets ?? [])
  for (const l of m.locations?.buckets ?? []) {
   const f = l.latest?.hits.hits[0]?.fields;
   const us = first<number>(f, 'monitor.duration.us');
   out.push({
    monitorId: safeId(first(f, 'monitor.id')), name: redactText(first<string>(f, 'monitor.name'), 200), location: first(f, 'observer.geo.name'),
    status: first(f, 'monitor.status'), durationMs: typeof us === 'number' ? Math.round(us / 1000) : null, checkedAt: iso(first(f, '@timestamp')),
   });
  }
 return out;
}
export async function fetchSynthetics(client: ElasticClient, patterns: readonly string[], monitorIds: readonly string[], w: Window): Promise<Parsed<SyntheticResult>> {
 if (monitorIds.length === 0 || patterns.length === 0) return { items: [], dropped: 0 };
 const r = await client.es<SearchBody>('POST', `/${indexList(patterns)}/_search`, syntheticsQuery(monitorIds, w));
 return keep(syntheticResultSchema, parseSyntheticsAggs(r.body.aggregations));
}

// ── Cases (Kibana, read-only) ──

interface KibanaCase { id?: unknown; title?: unknown; status?: unknown; tags?: unknown; created_at?: unknown; updated_at?: unknown; totalAlerts?: unknown }
export function parseCase(c: KibanaCase): unknown {
 return {
  caseId: safeId(c.id), title: redactText(typeof c.title === 'string' ? c.title : null, 300), status: c.status,
  tags: Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === 'string').slice(0, 20) : [],
  createdAt: iso(c.created_at), updatedAt: c.updated_at ? iso(c.updated_at) : null,
  totalAlerts: typeof c.totalAlerts === 'number' ? c.totalAlerts : 0,
 };
}
export async function fetchCases(client: ElasticClient, tags: readonly string[]): Promise<Parsed<CaseResult>> {
 if (tags.length === 0) return { items: [], dropped: 0 };
 // Case descriptions and comments are never read; titles are redacted.
 const r = await client.kibana<{ cases?: KibanaCase[] }>('/api/cases/_find', { tags: [...tags], status: ['open', 'in-progress'], owner: 'observability', perPage: '50', sortField: 'updatedAt', sortOrder: 'desc' });
 return keep(caseResultSchema, (r.body.cases ?? []).map(parseCase));
}

// ── Subject events: APM and RUM for one verified app subject (E2 uses these; fixed here so fixtures cover them) ──

export const SUBJECT_FIELDS = ['@timestamp', 'processor.event', 'service.name', 'transaction.name', 'transaction.type', 'error.grouping_name', 'event.outcome',
 'http.response.status_code', 'transaction.duration.us', 'trace.id', 'transaction.id', 'client.geo.region_name', 'client.geo.country_iso_code'] as const;
export function subjectQuery(subject: string, services: ElasticAppMapping['services'], w: Window, size = 50) {
 return {
  size: Math.min(size, 100), track_total_hits: false, _source: false, fields: [...SUBJECT_FIELDS], sort: [{ '@timestamp': 'desc' }],
  query: { bool: { filter: [{ term: { 'user.id': subject } }, serviceFilter(services), range(w), { terms: { 'processor.event': ['error', 'transaction'] } }] } },
 };
}
export function parseSubjectEvent(f: Fields | undefined, source: 'APM' | 'RUM'): unknown {
 const event = first(f, 'processor.event');
 const pageLoad = first(f, 'transaction.type') === 'page-load';
 const us = first<number>(f, 'transaction.duration.us');
 const outcome = first(f, 'event.outcome');
 const status = first<number>(f, 'http.response.status_code');
 return {
  at: iso(first(f, '@timestamp')), source,
  kind: event === 'error' ? 'error' : pageLoad ? 'page_load' : 'transaction',
  service: first(f, 'service.name'),
  name: redactText(first<string>(f, event === 'error' ? 'error.grouping_name' : 'transaction.name') ?? (event === 'error' ? 'Error' : 'Transaction'), 200),
  outcome: outcome === 'success' || outcome === 'failure' ? outcome : 'unknown',
  httpStatus: typeof status === 'number' ? status : null,
  durationMs: typeof us === 'number' ? Math.round(us / 1000) : null,
  traceId: safeId(first(f, 'trace.id')), transactionId: safeId(first(f, 'transaction.id')),
  region: first(f, 'client.geo.region_name') ?? first(f, 'client.geo.country_iso_code') ?? null,
 };
}
export async function fetchSubjectEvents(client: ElasticClient, source: 'APM' | 'RUM', patterns: readonly string[], subject: string, services: ElasticAppMapping['services'], w: Window): Promise<Parsed<SubjectEvent>> {
 if (patterns.length === 0) return { items: [], dropped: 0 };
 const r = await client.es<SearchBody>('POST', `/${indexList(patterns)}/_search`, subjectQuery(subject, services, w));
 return keep(subjectEventSchema, r.body.hits.hits.map(h => parseSubjectEvent(h.fields, source)));
}

// ── Discovery ──

export interface FamilyProbe { status: FamilyStatus; code: string | null }

function probeResult(e: unknown): FamilyProbe {
 if (!(e instanceof ElasticError)) return { status: 'error', code: 'UNEXPECTED' };
 if (e.code === 'FORBIDDEN' || e.code === 'UNAUTHENTICATED') return { status: 'denied', code: e.elasticType ?? e.code };
 if (e.code === 'NOT_FOUND') return { status: 'unsupported', code: e.elasticType ?? e.code };
 return { status: 'error', code: e.code };
}

/** One cheap read per family: supported, unsupported (not installed / no data stream) or denied (privileges). */
export async function probeFamily(client: ElasticClient, family: ElasticFamily): Promise<FamilyProbe> {
 try {
  switch (family) {
   case 'slo': await client.kibana('/api/observability/slos', { perPage: '1' }); break;
   case 'cases': await client.kibana('/api/cases/_find', { perPage: '1', owner: 'observability' }); break;
   case 'alerts': await client.es('POST', `/${encodeURIComponent(ALERT_INDEX)}/_search`, { size: 0, track_total_hits: false }, { allow_no_indices: 'false' }); break;
   default: await client.es('POST', `/${DEFAULT_PATTERNS[family].split(',').map(encodeURIComponent).join(',')}/_search`, { size: 0, track_total_hits: false }, { allow_no_indices: 'false' });
  }
  return { status: 'supported', code: null };
 } catch (e) { return probeResult(e); }
}

export async function versions(client: ElasticClient) {
 const es = await client.es<{ version?: { number?: string; build_flavor?: string } }>('GET', '/');
 let kb: { version?: { number?: string; build_flavor?: string } } | null = null;
 try { kb = (await client.kibanaRoot<{ version?: { number?: string; build_flavor?: string } }>('/api/status')).body; }
 catch (e) { if (!(e instanceof ElasticError) || !['FORBIDDEN', 'NOT_FOUND'].includes(e.code)) throw e; }
 const v = (x: unknown) => (typeof x === 'string' && /^[\w.+-]{1,40}$/.test(x) ? x : null);
 return {
  elasticsearch: { version: v(es.body?.version?.number), buildFlavor: v(es.body?.version?.build_flavor) },
  kibana: { version: v(kb?.version?.number), buildFlavor: v(kb?.version?.build_flavor) },
 };
}

// ── Counts (E1): affected subjects for a known issue, and event counts for mapping preview and isolation ──

/**
 * Distinct instrumented subjects with errors on the mapped services since `since`. Elasticsearch's cardinality is
 * approximate, and only subjects the application instruments are counted; the UI says both.
 */
export async function fetchAffectedSubjects(client: ElasticClient, patterns: readonly string[], services: ElasticAppMapping['services'], since: Date, now = new Date()): Promise<number> {
 if (patterns.length === 0 || services.length === 0) return 0;
 const r = await client.es<SearchBody>('POST', `/${indexList(patterns)}/_search`, {
  size: 0, track_total_hits: false,
  query: { bool: { filter: [serviceFilter(services), range({ from: since, to: now }), { term: { 'processor.event': 'error' } }, { exists: { field: 'user.id' } }] } },
  aggs: { subjects: { cardinality: { field: 'user.id' } } },
 });
 const v = (r.body.aggregations?.subjects as { value?: unknown } | undefined)?.value;
 return typeof v === 'number' ? v : 0;
}

/** Number of documents matching every filter in the window (size 0). */
export async function countEvents(client: ElasticClient, patterns: readonly string[], filters: unknown[], w: Window): Promise<number> {
 if (patterns.length === 0) return 0;
 const r = await client.es<{ hits: { total?: { value?: number } } }>('POST', `/${indexList(patterns)}/_search`, {
  size: 0, track_total_hits: true, query: { bool: { filter: [...filters, range(w)] } },
 });
 return r.body.hits.total?.value ?? 0;
}

/** The most recent executed runs across the mapped monitors (newest first), for the card's run strip. */
export async function fetchRecentRuns(client: ElasticClient, patterns: readonly string[], monitorIds: readonly string[], w: Window, size = 12): Promise<Parsed<SyntheticResult>> {
 if (monitorIds.length === 0 || patterns.length === 0) return { items: [], dropped: 0 };
 const r = await client.es<SearchBody>('POST', `/${indexList(patterns)}/_search`, {
  size, track_total_hits: false, _source: false, fields: [...SYNTHETIC_FIELDS], sort: [{ '@timestamp': 'desc' }],
  query: { bool: { filter: [{ terms: { 'monitor.id': [...monitorIds] } }, { exists: { field: 'summary' } }, range(w)] } },
 });
 return keep(syntheticResultSchema, r.body.hits.hits.map(h => {
  const f = h.fields; const us = first<number>(f, 'monitor.duration.us');
  return { monitorId: safeId(first(f, 'monitor.id')), name: redactText(first<string>(f, 'monitor.name'), 200), location: first(f, 'observer.geo.name'),
   status: first(f, 'monitor.status'), durationMs: typeof us === 'number' ? Math.round(us / 1000) : null, checkedAt: iso(first(f, '@timestamp')) };
 }));
}
