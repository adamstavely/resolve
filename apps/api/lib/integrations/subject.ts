import type { Pool } from 'pg';
import {
 OBSERVABILITY_TOOL_VERSIONS, type ElasticAppMapping, type ElasticFamily, type KnownIssue, type MatchedIssue, type RegistryApp, type SubjectContext,
 type SubjectEvent, type SubjectLog, type SubjectStatus, type SyntheticResult,
} from '@resolve/contracts';
import type { Sealer } from '../crypto';
import { callTenantTool, type ToolFailure } from '../tenants/mcp';
import { tenantHealth } from '../tenants/protocol';
import { clientFor, ConnectionError } from './connections';
import { ElasticError } from './elastic/client';
import { fetchSubjectEvents, fetchSubjectLogs, fetchSynthetics } from './elastic/families';
import { activeIssues } from './observability';

/*
 * Customer context (plan 14, E2; prototype board 1). The customer is identified only by the application's verified
 * external id (QB-OBS-1), read with the person's own grant, which also re-checks that they may see this ticket or
 * conversation before anything is searched. Without a verified id, or without a mapping, the panel shows service-level
 * context and says why. Trace ids, log lines and Kibana links are included only for observability.restricted.
 */

export const SUBJECT_WINDOW_HOURS = 24;
const CACHE_MS = 60_000;
export const COVERAGE = 'APM keeps every error but only a sample of successful requests, and real-user monitoring covers browser sessions only. No events here does not mean nothing went wrong.';

type ElasticPart = { events: SubjectEvent[]; logs: SubjectLog[]; synthetics: SyntheticResult[]; missing: ElasticFamily[]; fetchedAt: string };
const cache = new Map<string, { at: number; part: ElasticPart }>();
export const clearSubjectCache = () => cache.clear();

interface MappingRow { mapping: ElasticAppMapping; revision: number; connection_id: string; environment: string }

export interface SubjectRequest { app: RegistryApp; userId: string; restricted: boolean; kind: 'ticket' | 'conversation'; id: string }
export type SubjectOutcome = { ok: true; context: SubjectContext; mapping: MappingRow | null } | { ok: false; reason: ToolFailure };

/** Who the customer is, with the person's own authority. Not advertised → the object is still checked, with no id. */
async function identify(req: SubjectRequest): Promise<{ ok: true; status: SubjectStatus; externalId: string | null } | { ok: false; reason: ToolFailure }> {
 const h = await tenantHealth(req.app).catch(() => null);
 const args = req.kind === 'ticket' ? { ticketId: req.id } : { conversationId: req.id };
 if (h?.status === 'ok' && (h.tools.get_customer_identity ?? 0) >= OBSERVABILITY_TOOL_VERSIONS.get_customer_identity) {
  const out = await callTenantTool(req.app, req.userId, 'get_customer_identity', args);
  if (!out.ok) return out;
  return out.data.verified ? { ok: true, status: 'verified', externalId: out.data.externalId } : { ok: true, status: 'unverified', externalId: null };
 }
 const seen = req.kind === 'ticket' ? await callTenantTool(req.app, req.userId, 'get_ticket', { ticketId: req.id }) : await callTenantTool(req.app, req.userId, 'get_conversation', { conversationId: req.id });
 return seen.ok ? { ok: true, status: 'not_reported', externalId: null } : { ok: false, reason: seen.reason };
}

export function matchIssues(issues: KnownIssue[], events: SubjectEvent[], verified: boolean): MatchedIssue[] {
 return issues.map(i => {
  const since = Date.parse(i.since);
  const inWindow = events.filter(e => e.kind === 'error' && Date.parse(e.at) >= since && (!i.service || e.service === i.service));
  const matched = ['Same application'];
  const missing: string[] = [];
  if (i.service) matched.push(`Service ${i.service}`); else missing.push('The source does not name a service');
  if (!verified) missing.push("This customer's own errors (the application did not identify them)");
  else if (inWindow.length) matched.push(`${inWindow.length} of this customer's errors since it began`);
  else missing.push('No errors from this customer since it began');
  return { issueId: i.id, title: i.title, kind: i.kind, providerId: i.providerId, since: i.since, matched, missing, customerErrorsInWindow: inWindow.length };
 });
}

const strip = (e: SubjectEvent): SubjectEvent => ({ ...e, traceId: null, transactionId: null });

export async function subjectContext(db: Pick<Pool, 'query' | 'connect'>, seal: Sealer, req: SubjectRequest, now = new Date()): Promise<SubjectOutcome> {
 const who = await identify(req);
 if (!who.ok) return who;
 const window = { from: new Date(now.getTime() - SUBJECT_WINDOW_HOURS * 3600_000), to: now };
 const base: SubjectContext = {
  appKey: req.app.appKey, objectKind: req.kind, objectId: req.id, subject: { status: who.status, externalId: who.externalId },
  window: { from: window.from.toISOString(), to: window.to.toISOString() }, fetchedAt: now.toISOString(), completeness: 'complete', missing: [],
  restricted: req.restricted, events: [], logs: [], lastSession: null, synthetics: [], matchedIssues: [], coverage: COVERAGE, kibanaTraceBase: null,
 };
 const m = (await db.query(
  `SELECT m.mapping, m.revision, m.connection_id, m.environment FROM elastic_app_mappings m JOIN integration_connections c ON c.id = m.connection_id
   WHERE m.app_key = $1 AND m.state = 'active' AND NOT c.kill_switch ORDER BY m.environment LIMIT 1`, [req.app.appKey])).rows[0] as MappingRow | undefined;
 if (!m) return { ok: true, context: { ...base, subject: { ...base.subject, status: base.subject.status === 'verified' ? 'not_mapped' : base.subject.status }, completeness: 'unavailable' }, mapping: null };
 const issues = await activeIssues(db, [req.app.appKey]);
 let status: SubjectStatus = who.status;
 if (m.mapping.subjectPolicy === 'none' && status === 'verified') status = 'policy_none';
 const subject = status === 'verified' ? who.externalId! : null;

 const key = `${req.app.appKey}|${m.revision}|${subject ?? '-'}|${req.restricted}`;
 let part = cache.get(key)?.at && Date.now() - cache.get(key)!.at < CACHE_MS ? cache.get(key)!.part : undefined;
 if (!part) {
  let client;
  try { client = await clientFor(db, seal, m.connection_id); }
  catch (e) {
   if (e instanceof ConnectionError) return { ok: true, context: { ...base, subject: { status: 'unavailable', externalId: who.externalId }, completeness: 'unavailable', matchedIssues: matchIssues(issues, [], false) }, mapping: m };
   throw e;
  }
  const missing: ElasticFamily[] = [];
  const settle = async <T>(family: ElasticFamily, work: () => Promise<{ items: T[] }>): Promise<T[]> => {
   try { return (await work()).items; } catch (e) { if (e instanceof ElasticError) { missing.push(family); return []; } throw e; }
  };
  const [apm, rum, logs, synthetics] = await Promise.all([
   subject ? settle('apm', () => fetchSubjectEvents(client, 'APM', m.mapping.indices.apm, subject, m.mapping.services, window)) : [],
   subject ? settle('rum', () => fetchSubjectEvents(client, 'RUM', m.mapping.indices.rum, subject, m.mapping.services, window)) : [],
   subject && req.restricted ? settle('logs', () => fetchSubjectLogs(client, m.mapping.indices.logs, subject, m.mapping.services, window)) : [],
   settle('synthetics', () => fetchSynthetics(client, m.mapping.indices.synthetics, m.mapping.monitorIds, { from: new Date(now.getTime() - 15 * 60_000), to: now })),
  ]);
  part = { events: [...apm, ...rum].sort((a, b) => b.at.localeCompare(a.at)), logs, synthetics, missing, fetchedAt: now.toISOString() };
  cache.set(key, { at: Date.now(), part });
 }
 const rumWithRegion = part.events.find(e => e.source === 'RUM' && e.region);
 const configured = (subject ? 2 : 0) + (subject && req.restricted ? 1 : 0) + 1;
 return {
  ok: true, mapping: m,
  context: {
   ...base, subject: { status, externalId: who.externalId }, fetchedAt: part.fetchedAt,
   completeness: part.missing.length === 0 ? 'complete' : part.missing.length >= configured ? 'unavailable' : 'partial', missing: part.missing,
   events: req.restricted ? part.events : part.events.map(strip),
   logs: req.restricted ? part.logs : [],
   lastSession: rumWithRegion ? { region: rumWithRegion.region!, at: rumWithRegion.at } : null,
   synthetics: part.synthetics,
   matchedIssues: matchIssues(issues, part.events, status === 'verified'),
   kibanaTraceBase: req.restricted && m.mapping.deepLinkBase ? `${m.mapping.deepLinkBase.replace(/\/$/, '')}/app/apm/link-to/trace/` : null,
  },
 };
}
