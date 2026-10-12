import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AlertResult, CaseResult, ElasticAppMapping, SloResult, SyntheticResult } from '@resolve/contracts';
import type { Sealer } from '../crypto';
import { transaction } from '../db';
import { clientFor, ConnectionError } from './connections';
import { ElasticError } from './elastic/client';
import { fetchAffectedSubjects, fetchAlerts, fetchCases, fetchRecentRuns, fetchSlos, fetchSynthetics } from './elastic/families';
import { aggregate, type Outcome } from './elastic/health';
import { notifyObservability } from './notify';

/*
 * Health polling (plan 12 §6, plan 14 E1). Runs in the integration worker, never in a request handler. Each active
 * mapping has one `poll` operation; a worker claims it with a lease and a fencing token, reads the configured
 * families, and commits the snapshot, known issues and a NOTIFY together, only while it still holds the lease.
 * Failures back off per operation: Elastic's Retry-After on 429, otherwise exponentially up to five minutes.
 * A refused credential records "unavailable" at once; a network failure leaves the last snapshot to go stale.
 */

export const workerId = () => `integrations-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const LEASE_SECONDS = 60;

export interface PollOperation { id: string; connection_id: string; app_key: string; operation_key: string; fencing_token: string; attempts: number }

/** Create poll operations for active mappings that do not have one (e.g. after a restart or a connection change). */
export async function ensureOperations(db: Pick<Pool, 'query'>) {
 await db.query(
  `INSERT INTO integration_operations (connection_id, app_key, kind, operation_key)
   SELECT connection_id, app_key, 'poll', app_key || ':' || environment FROM elastic_app_mappings WHERE state = 'active'
   ON CONFLICT (connection_id, kind, operation_key) DO NOTHING`);
}

export async function claim(db: Pick<Pool, 'query'>, owner: string): Promise<PollOperation | undefined> {
 return (await db.query(
  `UPDATE integration_operations o SET state = 'running', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2),
    fencing_token = o.fencing_token + 1, attempts = o.attempts + 1, updated_at = now()
   WHERE o.id = (
    SELECT p.id FROM integration_operations p
    JOIN elastic_app_mappings m ON p.operation_key = m.app_key || ':' || m.environment AND m.connection_id = p.connection_id
    JOIN integration_connections c ON c.id = p.connection_id
    WHERE p.kind = 'poll' AND m.state = 'active' AND NOT c.kill_switch AND p.not_before <= now()
      AND (p.state <> 'running' OR p.lease_expires_at < now())
    ORDER BY p.not_before LIMIT 1 FOR UPDATE OF p SKIP LOCKED)
   RETURNING o.id, o.connection_id, o.app_key, o.operation_key, o.fencing_token, o.attempts`, [owner, LEASE_SECONDS])).rows[0];
}

export class Fenced extends Error { constructor() { super('FENCED'); } }

async function holdsLease(tx: Pick<Pool, 'query'>, op: PollOperation) {
 const r = (await tx.query('SELECT fencing_token FROM integration_operations WHERE id = $1 FOR UPDATE', [op.id])).rows[0];
 if (!r || String(r.fencing_token) !== String(op.fencing_token)) throw new Fenced();
}

async function release(db: Pick<Pool, 'connect'>, op: PollOperation, delaySeconds: number, failureCode: string | null) {
 await transaction(db, async tx => {
  await holdsLease(tx, op);
  await tx.query(`UPDATE integration_operations SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, not_before = now() + make_interval(secs => $2),
    failure_code = $3, attempts = CASE WHEN $3::text IS NULL THEN 0 ELSE attempts END, updated_at = now() WHERE id = $1`, [op.id, delaySeconds, failureCode]);
 });
}

const settle = async <T>(work: () => Promise<{ items: T[]; missing?: string[] }>): Promise<Outcome<T>> => {
 try { const r = await work(); return { ok: true, items: r.items, missingIds: r.missing }; }
 catch (e) {
  if (e instanceof ElasticError) { if (e.code === 'RATE_LIMITED') throw e; return { ok: false, code: e.code }; }
  throw e;
 }
};
const REFUSED = new Set(['UNAUTHENTICATED', 'FORBIDDEN']);
const backoff = (attempts: number, poll: number) => Math.min(300, poll * 2 ** Math.min(attempts, 6));

export interface PollResult { outcome: 'polled' | 'unavailable' | 'deferred' | 'fenced' | 'gone'; state?: string; failure?: string }

export async function pollOnce(db: Pick<Pool, 'connect' | 'query'>, seal: Sealer, op: PollOperation, pollSeconds: number, now = () => new Date()): Promise<PollResult> {
 const m = (await db.query(
  `SELECT m.*, c.revision AS connection_revision, c.settings->>'spaceId' AS space_id FROM elastic_app_mappings m JOIN integration_connections c ON c.id = m.connection_id
   WHERE m.app_key || ':' || m.environment = $1 AND m.state = 'active' AND m.connection_id = $2`, [op.operation_key, op.connection_id])).rows[0] as
  ({ app_key: string; environment: string; mapping: ElasticAppMapping; revision: number; connection_revision: number; space_id: string } | undefined);
 if (!m) { await db.query('DELETE FROM integration_operations WHERE id = $1 AND fencing_token = $2', [op.id, op.fencing_token]); return { outcome: 'gone' }; }
 const map = m.mapping;
 let client;
 try { client = await clientFor(db, seal, op.connection_id); }
 catch (e) {
  if (e instanceof ConnectionError) { await release(db, op, pollSeconds, e.code).catch(() => {}); return { outcome: 'deferred', failure: e.code }; }
  throw e;
 }
 const started = now();
 const window = { from: new Date(started.getTime() - 24 * 3600_000), to: started };
 let slos: Outcome<SloResult> | undefined, alerts: Outcome<AlertResult> | undefined, synthetics: Outcome<SyntheticResult> | undefined, cases: Outcome<CaseResult> | undefined;
 try {
  [slos, alerts, synthetics, cases] = await Promise.all([
   map.sloIds.length ? settle(() => fetchSlos(client, map.sloIds)) : undefined,
   map.alertRuleIds.length ? settle(() => fetchAlerts(client, map.alertRuleIds, window)) : undefined,
   map.monitorIds.length ? settle(() => fetchSynthetics(client, map.indices.synthetics, map.monitorIds, { from: new Date(started.getTime() - 15 * 60_000), to: started })) : undefined,
   map.caseTags.length ? settle(() => fetchCases(client, map.caseTags)) : undefined,
  ]);
 } catch (e) {
  if (e instanceof ElasticError && e.code === 'RATE_LIMITED') { await release(db, op, e.retryAfterSeconds ?? pollSeconds, 'RATE_LIMITED').catch(() => {}); return { outcome: 'deferred', failure: 'RATE_LIMITED' }; }
  throw e;
 }
 // The run strip is a nicety: a failure here never changes health or completeness.
 const recent = synthetics?.ok ? await fetchRecentRuns(client, map.indices.synthetics, map.monitorIds, { from: new Date(started.getTime() - 3600_000), to: started }).then(r => r.items).catch(() => []) : [];
 const health = aggregate({ slos, alerts, synthetics: synthetics ? { ...synthetics, configured: map.monitorIds, recent } : undefined, others: cases ? { cases } : undefined });
 const failures = [slos, alerts, synthetics, cases].filter((o): o is { ok: false; code: string } => !!o && !o.ok);
 const refused = failures.length > 0 && failures.every(f => REFUSED.has(f.code));
 if (health.completeness === 'unavailable' && !refused) {
  // Network or server trouble: keep the last snapshot (it will go stale) and back off.
  const code = failures[0]?.code ?? 'UNAVAILABLE';
  await release(db, op, backoff(op.attempts, pollSeconds), code).catch(() => {});
  return { outcome: 'deferred', failure: code };
 }

 // Known issues: active alerts and open cases, with an approximate count of affected instrumented subjects.
 type IssueInput = { kind: 'alert' | 'case'; providerId: string; title: string; since: Date; service: string | null; criteria: Record<string, unknown> };
 const issues: IssueInput[] = [];
 if (alerts?.ok) for (const a of alerts.items.filter(x => x.status === 'active'))
  issues.push({ kind: 'alert', providerId: a.alertId, title: a.reason ?? a.ruleName, since: new Date(a.startedAt), service: a.service, criteria: { rule: a.ruleId, ruleName: a.ruleName, service: a.service, environment: a.environment } });
 if (cases?.ok) for (const c of cases.items)
  issues.push({ kind: 'case', providerId: c.caseId, title: c.title, since: new Date(c.createdAt), service: null, criteria: { tags: c.tags } });
 const affected = new Map<string, number>();
 for (const i of issues) {
  try { affected.set(i.providerId, await fetchAffectedSubjects(client, map.indices.apm, map.services, i.since, started)); } catch { /* counted as unknown */ }
 }

 const fetchedAt = now();
 const expiresAt = new Date(fetchedAt.getTime() + 2 * pollSeconds * 1000);
 try {
  await transaction(db, async tx => {
   await holdsLease(tx, op);
   await tx.query(
    `INSERT INTO observability_health_snapshots (app_key, environment, state, completeness, components, source_ids, connection_revision, mapping_revision, observed_at, fetched_at, expires_at, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [m.app_key, m.environment, health.state, health.completeness, JSON.stringify({ components: health.components, missing: health.missing, refused }),
     JSON.stringify({ slos: map.sloIds, rules: map.alertRuleIds, monitors: map.monitorIds, cases: cases?.ok ? cases.items.map(c => c.caseId) : [] }),
     m.connection_revision, m.revision, health.completeness === 'unavailable' ? null : started, fetchedAt, expiresAt, JSON.stringify(health.summary)]);
   const seen: string[] = [];
   for (const i of issues) {
    seen.push(`${i.kind}:${i.providerId}`);
    const count = affected.get(i.providerId);
    await tx.query(
     `INSERT INTO known_issues (connection_id, space_id, app_key, environment, provider_kind, provider_id, title, state, criteria, first_seen_at, last_seen_at, service, affected)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12)
      ON CONFLICT (connection_id, space_id, app_key, environment, provider_kind, provider_id)
      DO UPDATE SET title = EXCLUDED.title, state = 'active', criteria = EXCLUDED.criteria, last_seen_at = EXCLUDED.last_seen_at, service = EXCLUDED.service, affected = EXCLUDED.affected`,
     [op.connection_id, m.space_id, m.app_key, m.environment, i.kind, i.providerId, i.title.slice(0, 300), JSON.stringify(i.criteria), i.since, fetchedAt, i.service,
      count === undefined ? null : JSON.stringify({ count, approximate: true, since: i.since.toISOString(), measuredAt: fetchedAt.toISOString() })]);
   }
   // Only families that answered may close issues; a failed read says nothing about whether an issue ended.
   const closable = [alerts?.ok ? 'alert' : null, cases?.ok ? 'case' : null].filter(Boolean);
   if (closable.length) await tx.query(
    `UPDATE known_issues SET state = CASE provider_kind WHEN 'alert' THEN 'recovered' ELSE 'closed' END
     WHERE connection_id = $1 AND app_key = $2 AND environment = $3 AND state = 'active' AND provider_kind = ANY($4) AND NOT (provider_kind || ':' || provider_id = ANY($5))`,
    [op.connection_id, m.app_key, m.environment, closable, seen]);
   await tx.query(`UPDATE integration_operations SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, not_before = now() + make_interval(secs => $2),
     failure_code = $3, attempts = 0, updated_at = now() WHERE id = $1`, [op.id, pollSeconds, refused ? failures[0].code : null]);
   const at = fetchedAt.toISOString();
   await notifyObservability(tx, { type: 'health', appKey: m.app_key, environment: m.environment, at });
   await notifyObservability(tx, { type: 'issues', appKey: m.app_key, environment: m.environment, at });
  });
 } catch (e) { if (e instanceof Fenced) return { outcome: 'fenced' }; throw e; }
 return { outcome: refused ? 'unavailable' : 'polled', state: health.state };
}

/** Keep the latest snapshot per app and environment, and 24 hours of history (proposed retention). */
export async function prune(db: Pick<Pool, 'query'>) {
 await db.query(
  `DELETE FROM observability_health_snapshots s WHERE s.fetched_at < now() - interval '24 hours'
   AND s.id <> (SELECT id FROM observability_health_snapshots l WHERE l.app_key = s.app_key AND l.environment = s.environment ORDER BY fetched_at DESC LIMIT 1)`);
}

