import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
 OBSERVABILITY_SCHEMA_VERSION, type AppHealth, type ElasticFamily, type HealthState, type KnownIssue, type LinkCandidate, type RegistryApp,
} from '@resolve/contracts';
import { transaction, type Queryable } from '../db';
import { writeAudit } from '../audit';
import { callTenantTool, type ToolFailure } from '../tenants/mcp';
import { withStaleness } from './elastic/health';

/*
 * Observability read models (plan 14, E1). Browsers read committed snapshots, never Elastic. Every registered app
 * gets an entry: unmapped, switched off, not yet polled, unreachable and stale are all stated, so a missing number is
 * never mistaken for a healthy one. Health is service-level and needs observability.health; linking a ticket to an
 * issue needs the person to be able to read that ticket in the application, checked with their own grant.
 */

const EMPTY_SUMMARY: AppHealth['summary'] = { slos: { total: 0, healthy: 0, degrading: 0, violated: 0, noData: 0, worstBurn: null }, activeAlerts: 0, synthetics: { passing: 0, total: 0, failing: [], configured: 0, recent: [] } };

interface SnapshotRow {
 app_key: string; environment: string; state: HealthState; completeness: 'complete' | 'partial' | 'unavailable'; components: { components: AppHealth['components']; missing: ElasticFamily[] };
 connection_revision: number; mapping_revision: number; observed_at: Date | null; fetched_at: Date; expires_at: Date; summary: AppHealth['summary'];
}

export async function fleetHealth(db: Queryable, apps: RegistryApp[], pollSeconds: number, now = Date.now()): Promise<AppHealth[]> {
 const mappings = (await db.query(
  `SELECT m.app_key, m.environment, m.state, c.kill_switch FROM elastic_app_mappings m JOIN integration_connections c ON c.id = m.connection_id`)).rows as
  { app_key: string; environment: string; state: string; kill_switch: boolean }[];
 const snapshots = (await db.query(
  `SELECT DISTINCT ON (app_key, environment) * FROM observability_health_snapshots ORDER BY app_key, environment, fetched_at DESC`)).rows as SnapshotRow[];
 const out: AppHealth[] = [];
 for (const app of apps) {
  const mine = mappings.filter(m => m.app_key === app.appKey);
  if (mine.length === 0) { out.push(placeholder(app.appKey, '', 'not_configured')); continue; }
  for (const m of mine) {
   if (m.state !== 'active') { out.push(placeholder(app.appKey, m.environment, 'not_configured')); continue; }
   if (m.kill_switch) { out.push(placeholder(app.appKey, m.environment, 'kill_switch')); continue; }
   const s = snapshots.find(x => x.app_key === app.appKey && x.environment === m.environment);
   if (!s) { out.push(placeholder(app.appKey, m.environment, 'not_polled_yet')); continue; }
   out.push(fromSnapshot(s, pollSeconds, now));
  }
 }
 return out;
}

function placeholder(appKey: string, environment: string, reason: NonNullable<AppHealth['reason']>): AppHealth {
 return { appKey, environment, state: 'unknown', reason, provenance: null, components: [], summary: EMPTY_SUMMARY };
}

function fromSnapshot(s: SnapshotRow, pollSeconds: number, now: number): AppHealth {
 const { state } = withStaleness({ state: s.state, fetchedAt: s.fetched_at }, pollSeconds, now);
 return {
  appKey: s.app_key, environment: s.environment, state, reason: s.completeness === 'unavailable' ? 'connection_unavailable' : null,
  provenance: {
   schemaVersion: OBSERVABILITY_SCHEMA_VERSION, appKey: s.app_key, environment: s.environment, connectionRevision: s.connection_revision, mappingRevision: s.mapping_revision,
   observedAt: s.observed_at?.toISOString() ?? null, fetchedAt: s.fetched_at.toISOString(), expiresAt: s.expires_at.toISOString(),
   completeness: s.completeness, missing: s.components.missing ?? [],
  },
  // A stale snapshot keeps its components, so people can see what was last known and when.
  components: s.components.components ?? [], summary: normalizeSummary(s.summary),
 };
}

/**
 * Snapshots written by an older worker may lack fields added since (e.g. the SLO target behind a burn rate, the run
 * strip). Fill or drop them so one old row never breaks the whole read; the next poll rewrites it.
 */
function normalizeSummary(raw: Partial<AppHealth['summary']> | null | undefined): AppHealth['summary'] {
 const slos = { ...EMPTY_SUMMARY.slos, ...raw?.slos };
 if (slos.worstBurn && typeof slos.worstBurn.target !== 'number') slos.worstBurn = null;
 return { slos, activeAlerts: raw?.activeAlerts ?? 0, synthetics: { ...EMPTY_SUMMARY.synthetics, ...raw?.synthetics } };
}

interface IssueRow {
 id: string; app_key: string; environment: string; provider_kind: 'alert' | 'case'; provider_id: string; title: string; state: KnownIssue['state'];
 first_seen_at: Date; last_seen_at: Date; service: string | null; affected: KnownIssue['affected']; linked: string;
}
const issueView = (r: IssueRow): KnownIssue => ({
 id: r.id, appKey: r.app_key, environment: r.environment, kind: r.provider_kind, providerId: r.provider_id, title: r.title, state: r.state,
 since: r.first_seen_at.toISOString(), lastSeenAt: r.last_seen_at.toISOString(), service: r.service, affected: r.affected, linkedTickets: Number(r.linked),
});
const ISSUE_SELECT = `SELECT i.*, (SELECT count(*) FROM known_issue_links l WHERE l.issue_id = i.id) AS linked FROM known_issues i
 JOIN elastic_app_mappings m ON m.app_key = i.app_key AND m.environment = i.environment AND m.connection_id = i.connection_id AND m.state = 'active'
 JOIN integration_connections c ON c.id = i.connection_id AND NOT c.kill_switch`;

/** Live issues for the given apps (active only; recovered and closed issues leave the list). */
export async function activeIssues(db: Queryable, appKeys: string[]): Promise<KnownIssue[]> {
 const rows = (await db.query(`${ISSUE_SELECT} WHERE i.state = 'active' AND i.app_key = ANY($1) ORDER BY i.first_seen_at DESC`, [appKeys])).rows as IssueRow[];
 return rows.map(issueView);
}

export async function issueById(db: Queryable, appKey: string, id: string): Promise<KnownIssue | null> {
 const r = (await db.query(`${ISSUE_SELECT} WHERE i.id = $1 AND i.app_key = $2`, [id, appKey])).rows[0] as IssueRow | undefined;
 return r ? issueView(r) : null;
}

const MATCH_SLACK_MS = 15 * 60_000;
export const CANDIDATE_COVERAGE = 'Open tickets you can see in this application that changed while the issue was active. Customer errors are not compared yet, so nothing is pre-selected.';

/** Candidate tickets, from the person's own view of the application. Nothing is suggested without checkable evidence. */
export async function linkCandidates(db: Queryable, app: RegistryApp, userId: string, issue: KnownIssue): Promise<{ ok: true; candidates: LinkCandidate[] } | { ok: false; reason: ToolFailure }> {
 const out = await callTenantTool(app, userId, 'list_tickets', { statusCategory: 'open', sort: 'recent', limit: 100 });
 if (!out.ok) return out;
 const linked = new Set(((await db.query(`SELECT object_id FROM known_issue_links WHERE issue_id = $1 AND object_kind = 'ticket'`, [issue.id])).rows as { object_id: string }[]).map(r => r.object_id));
 const since = Date.parse(issue.since) - MATCH_SLACK_MS;
 const candidates = out.data.tickets.filter(t => Date.parse(t.updatedAt) >= since || linked.has(t.id)).map(t => ({
  ticketId: t.id, reference: t.reference, title: t.title, updatedAt: t.updatedAt,
  matched: ['Same application', ...(Date.parse(t.updatedAt) >= since ? ['Changed while the issue was active'] : [])],
  missing: ["The customer's errors in the issue window (needs customer context)"],
  suggested: false, linked: linked.has(t.id),
 }));
 return { ok: true, candidates };
}

const linkRequestId = (requestId: string, ticketId: string) => {
 const h = createHash('sha256').update(`${requestId}|${ticketId}`).digest('hex');
 return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * Link tickets the person confirmed. Each ticket is re-read with their own grant first (a guessed or hidden id is
 * refused), and a repeated request links nothing twice. Links live in Resolve only.
 */
export async function linkTickets(db: Pick<Pool, 'connect'>, app: RegistryApp, userId: string, issue: KnownIssue, requestId: string, ticketIds: string[]) {
 const unique = [...new Set(ticketIds)];
 const checks = await Promise.all(unique.map(async ticketId => ({ ticketId, out: await callTenantTool(app, userId, 'get_ticket', { ticketId }) })));
 const refused = checks.filter(c => !c.out.ok).map(c => ({ ticketId: c.ticketId, reason: c.out.ok ? '' : c.out.reason }));
 const allowed = checks.filter(c => c.out.ok).map(c => c.ticketId);
 return transaction(db, async tx => {
  const linked: string[] = [], alreadyLinked: string[] = [];
  for (const ticketId of allowed) {
   const r = await tx.query(
    `INSERT INTO known_issue_links (issue_id, app_key, object_kind, object_id, linked_by, matched_criteria, request_id) VALUES ($1, $2, 'ticket', $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`, [issue.id, app.appKey, ticketId, userId, JSON.stringify({ application: true, issueSince: issue.since }), linkRequestId(requestId, ticketId)]);
   (r.rowCount ? linked : alreadyLinked).push(ticketId);
  }
  await writeAudit(tx, { actorUserId: userId, operation: 'observability.issue_link', outcome: refused.length && !allowed.length ? 'denied' : 'succeeded',
   summary: { app: app.appKey, issue: issue.providerId, linked: linked.length, alreadyLinked: alreadyLinked.length, refused: refused.length } });
  return { linked, alreadyLinked, refused };
 });
}
