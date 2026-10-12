/*
 * The subset of Elasticsearch query DSL the Resolve adapter uses, evaluated over in-memory documents so the mock
 * behaves like a real cluster for those queries: bool (filter/must/must_not/should + minimum_should_match), term,
 * terms, range, exists, match_all; sort, size, search_after; `fields`; terms/top_hits/cardinality/value_count aggs.
 * Anything else is rejected with a parsing error, as Elasticsearch would, so an adapter change cannot silently pass.
 */
export type Doc = { _id: string; _index: string; source: Record<string, unknown> };

export class DslError extends Error { constructor(readonly type: string, message: string) { super(message); } }

const values = (doc: Doc, field: string): unknown[] => {
 const v = doc.source[field];
 return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
};
const asComparable = (v: unknown) => {
 if (typeof v === 'number') return v;
 if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? v : t; }
 return v as number;
};

export function matches(q: Record<string, unknown> | undefined, doc: Doc): boolean {
 if (!q || Object.keys(q).length === 0) return true;
 const [kind, body] = Object.entries(q)[0] as [string, Record<string, unknown>];
 switch (kind) {
  case 'match_all': return true;
  case 'bool': {
   const list = (k: string) => { const v = body[k]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; };
   const must = [...list('filter'), ...list('must')] as Record<string, unknown>[];
   if (!must.every(c => matches(c, doc))) return false;
   if ((list('must_not') as Record<string, unknown>[]).some(c => matches(c, doc))) return false;
   const should = list('should') as Record<string, unknown>[];
   const min = typeof body.minimum_should_match === 'number' ? body.minimum_should_match : must.length ? 0 : should.length ? 1 : 0;
   return should.filter(c => matches(c, doc)).length >= min;
  }
  case 'term': {
   const [field, raw] = Object.entries(body)[0];
   const want = typeof raw === 'object' && raw !== null && 'value' in raw ? (raw as { value: unknown }).value : raw;
   return values(doc, field).some(v => v === want);
  }
  case 'terms': {
   const [field, list] = Object.entries(body)[0];
   if (!Array.isArray(list)) throw new DslError('parsing_exception', '[terms] expects an array');
   return values(doc, field).some(v => list.includes(v));
  }
  case 'range': {
   const [field, r] = Object.entries(body)[0] as [string, Record<string, unknown>];
   return values(doc, field).some(raw => {
    const v = asComparable(raw);
    if (r.gte !== undefined && !(v >= asComparable(r.gte))) return false;
    if (r.gt !== undefined && !(v > asComparable(r.gt))) return false;
    if (r.lte !== undefined && !(v <= asComparable(r.lte))) return false;
    if (r.lt !== undefined && !(v < asComparable(r.lt))) return false;
    return true;
   });
  }
  case 'exists': {
   const field = String(body.field);
   return Object.keys(doc.source).some(k => k === field || k.startsWith(field + '.'));
  }
  default: throw new DslError('parsing_exception', `unknown query [${kind}]`);
 }
}

type SortSpec = { field: string; desc: boolean }[];
function sortSpec(sort: unknown): SortSpec {
 if (sort === undefined) return [];
 return (Array.isArray(sort) ? sort : [sort]).map(s => {
  if (typeof s === 'string') return { field: s, desc: false };
  const [field, o] = Object.entries(s as Record<string, unknown>)[0];
  const order = typeof o === 'string' ? o : (o as { order?: string }).order;
  return { field, desc: order === 'desc' };
 });
}
const sortValues = (doc: Doc, spec: SortSpec) => spec.map(s => asComparable(values(doc, s.field)[0] ?? null));
function compare(a: unknown[], b: unknown[], spec: SortSpec) {
 for (let i = 0; i < spec.length; i++) {
  if (a[i] === b[i]) continue;
  const less = (a[i] as number) < (b[i] as number) || b[i] === null;
  return (less ? -1 : 1) * (spec[i].desc ? -1 : 1);
 }
 return 0;
}

function fieldsOf(doc: Doc, fields: unknown): Record<string, unknown[]> | undefined {
 if (!Array.isArray(fields)) return undefined;
 const out: Record<string, unknown[]> = {};
 for (const f of fields) { const v = values(doc, String(f)); if (v.length) out[String(f)] = v; }
 return out;
}

function hit(doc: Doc, body: Record<string, unknown>, spec: SortSpec) {
 const h: Record<string, unknown> = { _index: doc._index, _id: doc._id, _score: null };
 if (body._source !== false) h._source = doc.source;
 const f = fieldsOf(doc, body.fields);
 if (f) h.fields = f;
 if (spec.length) h.sort = sortValues(doc, spec);
 return h;
}

const ALLOWED_BODY = new Set(['query', 'size', 'from', 'sort', 'search_after', '_source', 'fields', 'aggs', 'aggregations', 'track_total_hits', 'pit']);

export function search(docs: Doc[], body: Record<string, unknown>) {
 for (const k of Object.keys(body)) if (!ALLOWED_BODY.has(k)) throw new DslError('parsing_exception', `Unknown key for a START_OBJECT in [${k}].`);
 const spec = sortSpec(body.sort);
 let matched = docs.filter(d => matches(body.query as Record<string, unknown> | undefined, d));
 if (spec.length) matched = [...matched].sort((a, b) => compare(sortValues(a, spec), sortValues(b, spec), spec));
 if (Array.isArray(body.search_after)) {
  const after = (body.search_after as unknown[]).map(asComparable);
  matched = matched.filter(d => compare(sortValues(d, spec), after, spec) > 0);
 }
 const size = typeof body.size === 'number' ? body.size : 10;
 if (size > 10_000) throw new DslError('illegal_argument_exception', 'Result window is too large');
 const out: Record<string, unknown> = {
  took: 1, timed_out: false,
  hits: { total: { value: matched.length, relation: 'eq' }, max_score: null, hits: matched.slice(0, size).map(d => hit(d, body, spec)) },
 };
 const aggs = (body.aggs ?? body.aggregations) as Record<string, unknown> | undefined;
 if (aggs) out.aggregations = aggregate(matched, aggs);
 return out;
}

function aggregate(docs: Doc[], aggs: Record<string, unknown>): Record<string, unknown> {
 const out: Record<string, unknown> = {};
 for (const [name, def] of Object.entries(aggs as Record<string, Record<string, unknown>>)) {
  const sub = (def.aggs ?? def.aggregations) as Record<string, unknown> | undefined;
  if (def.terms) {
   const { field, size = 10 } = def.terms as { field: string; size?: number };
   const groups = new Map<unknown, Doc[]>();
   for (const d of docs) for (const v of values(d, field)) groups.set(v, [...(groups.get(v) ?? []), d]);
   const buckets = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0]))).slice(0, size)
    .map(([key, ds]) => ({ key, doc_count: ds.length, ...(sub ? aggregate(ds, sub) : {}) }));
   out[name] = { doc_count_error_upper_bound: 0, sum_other_doc_count: Math.max(0, groups.size - size), buckets };
  } else if (def.top_hits) {
   const th = def.top_hits as Record<string, unknown>;
   const spec = sortSpec(th.sort);
   const sorted = spec.length ? [...docs].sort((a, b) => compare(sortValues(a, spec), sortValues(b, spec), spec)) : docs;
   out[name] = { hits: { total: { value: docs.length, relation: 'eq' }, hits: sorted.slice(0, Number(th.size ?? 3)).map(d => hit(d, th, spec)) } };
  } else if (def.cardinality) {
   const field = (def.cardinality as { field: string }).field;
   out[name] = { value: new Set(docs.flatMap(d => values(d, field))).size };
  } else if (def.value_count) {
   const field = (def.value_count as { field: string }).field;
   out[name] = { value: docs.flatMap(d => values(d, field)).length };
  } else throw new DslError('parsing_exception', `unknown aggregation type in [${name}]`);
 }
 return out;
}

/** `*` wildcard match for index expressions. */
export function wildcard(pattern: string, name: string) {
 const re = new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
 return re.test(name);
}
