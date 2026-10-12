import type { Pool } from 'pg';
import type { ElasticAppMapping, Receipt } from '@resolve/contracts';
import type { Sealer } from '../crypto';
import type { Queryable } from '../db';
import { clientFor } from './connections';
import { ElasticError } from './elastic/client';
import { fetchOperationEvents } from './elastic/families';

/*
 * Verified receipts (plan 12 §7, plan 14 E3; prototype board 3). Each stage says what was actually observed and by
 * whom: Resolve recorded it, the application accepted it, the application confirmed the record, and, where an
 * expectation is defined, a downstream system was seen handling it in telemetry (matched on the operation id the
 * application carries, QB-OBS-2). Acceptance never masquerades as delivery: a relay accepting an email is not the
 * inbox, and no telemetry match is not proof of failure. Late evidence upgrades an "unverified" receipt.
 */

interface Expectation { key: string; title: string; service: string; watchMinutes: number }
/** Downstream expectations per operation. Operations without one get no downstream stage claim. */
export const EXPECTATIONS: Record<string, Expectation> = {
 'ticket.reply': { key: 'notification_accepted', title: 'Notification accepted by the mail relay', service: 'notification-service', watchMinutes: 10 },
 'conversation.reply': { key: 'notification_accepted', title: 'Notification accepted by the mail relay', service: 'notification-service', watchMinutes: 10 },
};
const LATE_EVIDENCE_HOURS = 24;

export async function trackReceipt(db: Queryable, op: { id: string; app_key: string; operation: string }) {
 const e = EXPECTATIONS[op.operation];
 if (!e) return;
 await db.query(
  `INSERT INTO action_receipt_observations (operation_id, app_key, operation, expectation, state, deadline_at) VALUES ($1, $2, $3, $4, 'pending', now() + make_interval(mins => $5))
   ON CONFLICT (operation_id) DO NOTHING`, [op.id, op.app_key, op.operation, e.key, e.watchMinutes]);
}

/** Worker step: look for downstream evidence for open receipts, per app, in one query per app. */
export async function watchReceipts(db: Pick<Pool, 'query' | 'connect'>, seal: Sealer, now = new Date()) {
 const open = (await db.query(
  `SELECT operation_id, app_key, state, deadline_at, created_at FROM action_receipt_observations
   WHERE state IN ('pending', 'unverified') AND created_at > now() - make_interval(hours => $1) ORDER BY created_at LIMIT 200`, [LATE_EVIDENCE_HOURS])).rows as
  { operation_id: string; app_key: string; state: string; deadline_at: Date; created_at: Date }[];
 const byApp = new Map<string, typeof open>();
 for (const r of open) byApp.set(r.app_key, [...(byApp.get(r.app_key) ?? []), r]);
 for (const [appKey, rows] of byApp) {
  const m = (await db.query(`SELECT m.mapping, m.connection_id FROM elastic_app_mappings m JOIN integration_connections c ON c.id = m.connection_id
   WHERE m.app_key = $1 AND m.state = 'active' AND NOT c.kill_switch LIMIT 1`, [appKey])).rows[0] as { mapping: ElasticAppMapping; connection_id: string } | undefined;
  let found: Awaited<ReturnType<typeof fetchOperationEvents>> = [];
  if (m) {
   try {
    const client = await clientFor(db, seal, m.connection_id);
    const from = new Date(Math.min(...rows.map(r => r.created_at.getTime())) - 60_000);
    found = await fetchOperationEvents(client, m.mapping.indices.apm, rows.map(r => r.operation_id), { from, to: now });
   } catch (e) { if (!(e instanceof ElasticError)) throw e; }
  }
  for (const r of rows) {
   const ev = found.find(f => f.operationId === r.operation_id);
   if (ev) {
    const ok = ev.outcome !== 'failure' && (ev.status === null || ev.status < 400);
    await db.query(`UPDATE action_receipt_observations SET state = $2, observed_at = $3, source = $4, detail = $5, checked_at = now() WHERE operation_id = $1`,
     [r.operation_id, ok ? 'observed' : 'failed', ev.at, ev.service, ev.status ? `HTTP ${ev.status}` : ev.outcome]);
   } else if (r.state === 'pending' && r.deadline_at <= now) {
    await db.query(`UPDATE action_receipt_observations SET state = 'unverified', detail = $2, checked_at = now() WHERE operation_id = $1`,
     [r.operation_id, m ? 'Not seen in telemetry yet' : 'This application is not connected to Elastic']);
   } else await db.query('UPDATE action_receipt_observations SET checked_at = now() WHERE operation_id = $1', [r.operation_id]);
  }
 }
}

const LABELS: Record<string, string> = {
 'ticket.reply': 'Reply', 'conversation.reply': 'Reply', 'ticket.note': 'Internal note', 'conversation.note': 'Internal note',
 'ticket.status': 'Status change', 'conversation.status': 'Status change', 'ticket.assign': 'Assignment', 'conversation.assign': 'Assignment', 'conversation.mark_read': 'Mark read',
};
export const actionLabel = (op: string, summary?: Record<string, unknown>) => {
 if (op.endsWith('.status')) { const s = summary?.status ?? summary?.statusCategory; return s === 'closed' ? (op.startsWith('ticket') ? 'Resolved a ticket' : 'Closed a conversation') : `Set status to ${s ?? 'a new value'}`; }
 return LABELS[op] ?? op;
};

interface OpRow { id: string; app_key: string; operation: string; target_type: string; target_id: string; state: string; failure_code: string | null; tenant_record_id: string | null;
 result: { status?: string | null } | null; summary: Record<string, unknown>; created_at: Date; completed_at: Date | null; display_name: string }

export async function receiptFor(db: Queryable, operationId: string, userId: string): Promise<Receipt | null> {
 const op = (await db.query(`SELECT o.*, u.display_name FROM operations o JOIN users u ON u.id = o.user_id WHERE o.id = $1 AND o.user_id = $2`, [operationId, userId])).rows[0] as OpRow | undefined;
 if (!op) return null;
 const obs = (await db.query('SELECT * FROM action_receipt_observations WHERE operation_id = $1', [operationId])).rows[0] as
  { state: string; observed_at: Date | null; source: string | null; detail: string | null; deadline_at: Date } | undefined;
 const pre = (await db.query('SELECT outcome, override_reason FROM action_preflights WHERE operation_id = $1', [operationId])).rows[0] as { outcome: string; override_reason: string | null } | undefined;
 const expectation = EXPECTATIONS[op.operation];
 const accepted = op.state === 'succeeded';
 const stages: Receipt['stages'] = [
  { key: 'recorded', title: "Recorded in Resolve's audit", state: 'ok', source: 'resolve-audit', at: op.created_at.toISOString(), detail: 'Shows it was logged, not that it happened.' },
  { key: 'accepted', title: `Accepted by the application`, state: accepted ? 'ok' : op.state === 'failed' || op.state === 'denied' ? 'bad' : 'wait', source: op.app_key,
   at: op.completed_at?.toISOString() ?? null, detail: op.state === 'uncertain' ? 'The application did not confirm it. Check the result before trying again.' : op.failure_code },
  { key: 'confirmed', title: 'Record confirmed by the application', state: accepted && (op.tenant_record_id || op.result) ? 'ok' : accepted ? 'na' : 'wait', source: op.app_key,
   at: op.completed_at?.toISOString() ?? null, detail: op.tenant_record_id ? `record ${op.tenant_record_id}` : op.result?.status ? `status now ${op.result.status}` : null },
 ];
 if (expectation) stages.push({
  key: expectation.key, title: expectation.title, source: obs?.source ?? expectation.service,
  state: obs?.state === 'observed' ? 'ok' : obs?.state === 'failed' ? 'bad' : 'wait', at: obs?.observed_at?.toISOString() ?? null,
  detail: obs?.state === 'observed' ? obs.detail : obs?.state === 'unverified' ? `${obs.detail ?? 'Not seen in telemetry'}. That does not mean it failed; late evidence still counts.`
   : obs?.state === 'failed' ? `The relay reported a failure (${obs.detail}).` : accepted ? `Watching telemetry until ${obs?.deadline_at.toISOString().slice(11, 16) ?? '—'} UTC` : null,
 });
 else stages.push({ key: 'downstream', title: 'Downstream confirmation', state: 'na', source: '—', at: null, detail: 'No downstream signal is defined for this action.' });

 const state: Receipt['state'] = op.state === 'failed' || op.state === 'denied' || obs?.state === 'failed' ? 'failed' : !accepted ? 'pending'
  : obs?.state === 'observed' ? 'observed' : obs?.state === 'unverified' ? 'unverified' : 'accepted';
 const label = actionLabel(op.operation, op.summary);
 const title = state === 'observed' ? `${label} handed to the mail relay` : state === 'failed' ? `${label} did not go through` : state === 'pending' ? `${label} not confirmed yet`
  : state === 'unverified' ? `${label} sent; delivery not seen` : expectation ? `${label} sent` : label;
 const subtitle = state === 'observed' ? 'Confirmed in the systems, not just sent. The relay accepting it does not prove it reached the inbox.'
  : state === 'accepted' && expectation ? 'Accepted by the application. Watching for the downstream signal.'
  : state === 'accepted' ? 'Accepted and confirmed by the application.' : state === 'unverified' ? 'Accepted by the application; no downstream signal was seen in the window.'
  : state === 'failed' ? 'The application or a downstream system reported a failure.' : 'Waiting for the application.';
 return {
  operationId: op.id, appKey: op.app_key, operation: op.operation, state, title, subtitle, stages,
  facts: { action: label, target: op.target_id, agent: op.display_name, clearance: null, ref: op.id.slice(0, 8) },
  preflight: pre ? { outcome: pre.outcome, overrideReason: pre.override_reason } : null,
 };
}

/** Console-wide recent actions with their verification; targets only for the person's own actions. */
export async function liveActivity(db: Queryable, userId: string, appKeys: string[]) {
 const rows = (await db.query(
  `SELECT o.id, o.user_id, o.app_key, o.operation, o.summary, o.target_id, o.created_at, u.display_name, r.state AS receipt
   FROM operations o JOIN users u ON u.id = o.user_id LEFT JOIN action_receipt_observations r ON r.operation_id = o.id
   WHERE o.state = 'succeeded' AND o.app_key = ANY($1) AND o.created_at > now() - interval '24 hours' ORDER BY o.created_at DESC LIMIT 20`, [appKeys])).rows as
  { id: string; user_id: string; app_key: string; operation: string; summary: Record<string, unknown>; target_id: string; created_at: Date; display_name: string; receipt: string | null }[];
 return rows.map(r => ({
  at: r.created_at.toISOString(), action: actionLabel(r.operation, r.summary), appKey: r.app_key, actor: r.display_name, own: r.user_id === userId,
  operationId: r.user_id === userId ? r.id : null, target: r.user_id === userId ? r.target_id : null,
  verification: (r.receipt === 'observed' ? 'verified' : r.receipt === 'pending' ? 'awaiting' : r.receipt === 'unverified' || r.receipt === 'failed' ? 'unverified' : 'none') as 'verified' | 'awaiting' | 'unverified' | 'none',
 }));
}

// ── Issue subscriptions: "notify me when it clears" ──

export async function subscribe(db: Queryable, userId: string, issueId: string, objectKind: string | null, objectId: string | null) {
 await db.query(`INSERT INTO issue_subscriptions (user_id, issue_id, object_kind, object_id) VALUES ($1, $2, $3, $4)
  ON CONFLICT (user_id, issue_id) DO UPDATE SET acknowledged_at = NULL, object_kind = COALESCE(EXCLUDED.object_kind, issue_subscriptions.object_kind), object_id = COALESCE(EXCLUDED.object_id, issue_subscriptions.object_id)`,
  [userId, issueId, objectKind, objectId]);
}
export async function subscriptionsFor(db: Queryable, userId: string) {
 const rows = (await db.query(`SELECT s.id, s.issue_id, s.object_kind, s.object_id, s.created_at, i.app_key, i.title, i.provider_id, i.provider_kind, i.state
  FROM issue_subscriptions s JOIN known_issues i ON i.id = s.issue_id WHERE s.user_id = $1 AND s.acknowledged_at IS NULL ORDER BY s.created_at DESC`, [userId])).rows;
 return rows.map(r => ({ id: r.id, issueId: r.issue_id, appKey: r.app_key, title: r.title, providerId: r.provider_id, kind: r.provider_kind, cleared: r.state !== 'active',
  objectKind: r.object_kind, objectId: r.object_id, createdAt: (r.created_at as Date).toISOString() }));
}
export async function acknowledge(db: Queryable, userId: string, id: string) {
 await db.query('UPDATE issue_subscriptions SET acknowledged_at = now() WHERE id = $1 AND user_id = $2', [id, userId]);
}
