import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalJson, type ActionTool, type Operation, type OperationState, type RegistryApp } from '@resolve/contracts';
import { transaction, type Queryable } from './db';
import { writeAudit } from './audit';
import type { Sealer } from './crypto';
import { rpc, type RpcOutcome } from './tenants/mcp';

/*
 * Operator actions (plan 00 phase 3, plan 09). Each intent is recorded before dispatch and every transition is
 * appended to audit_events, so the human, the app and the tenant record stay correlated.
 *
 * Retry rules (plan 01; no automatic retry of non-idempotent actions):
 * - Keyed message writes (reply/note) send the operation id as the tenant operation key. If the outcome is unknown,
 *   the operation becomes `uncertain`; the user may reconcile (ask the tenant) or retry with the same key, which the
 *   tenant replays instead of sending twice.
 * - Version-checked writes (assign/status) carry the version the user saw. If the outcome is unknown, refreshing
 *   shows the truth, and a retry with a stale version is refused by the tenant, so it cannot apply twice.
 */
export interface ActionSpec {
 operation: string;             // e.g. conversation.reply
 tool: ActionTool;
 targetType: 'conversation' | 'ticket';
 targetId: string;
 args: Record<string, unknown>; // tool arguments (operationKey is added for keyed tools)
 keyed: boolean;
 summary: Record<string, string | number | boolean | null>;
 /** Message text, audited in full (sealed) on the operation's first transition. */
 content?: string;
}

interface Row {
 id: string; user_id: string; app_key: string; operation: string; target_type: 'conversation' | 'ticket'; target_id: string; payload_hash: string;
 summary: Record<string, unknown>; state: OperationState; failure_code: string | null; tenant_record_id: string | null; result: Operation['result'];
 created_at: Date; completed_at: Date | null;
}

export class OperationConflict extends Error {}

const hashOf = (spec: ActionSpec) => createHash('sha256').update(canonicalJson({ op: spec.operation, target: spec.targetId, args: spec.args })).digest('hex');
const AUDIT_OUTCOME: Record<OperationState, string> = { pending: 'pending', succeeded: 'succeeded', failed: 'failed', uncertain: 'uncertain', denied: 'denied' };

async function transition(db: Queryable, row: Pick<Row, 'id' | 'user_id' | 'app_key' | 'operation' | 'target_id'>, state: OperationState, code: string | null,
 extra: Record<string, string | number | boolean | null> = {}, content?: string, seal?: Sealer) {
 await writeAudit(db, { operationId: row.id, actorUserId: row.user_id, operation: row.operation, outcome: AUDIT_OUTCOME[state] as never,
  summary: { app: row.app_key, target: row.target_id, ...(code ? { code } : {}), ...extra }, content }, seal);
}

export function toApi(row: Row, keyed: boolean): Operation {
 const next: Operation['next'] =
  row.state === 'uncertain' ? (keyed ? 'reconcile' : 'refresh_and_retry')
  : row.state === 'failed' && row.failure_code === 'NOT_SENT' ? 'retry_same_operation'
  : row.state === 'failed' && row.failure_code === 'CONFLICT' ? 'refresh_and_retry'
  : 'none';
 return { id: row.id, appKey: row.app_key, operation: row.operation, targetType: row.target_type, targetId: row.target_id, state: row.state,
  failureCode: row.failure_code, tenantRecordId: row.tenant_record_id, createdAt: row.created_at.toISOString(),
  completedAt: row.completed_at?.toISOString() ?? null, next, result: row.result ?? null };
}

export const KEYED_OPERATIONS = new Set(['conversation.reply', 'conversation.note', 'ticket.reply', 'ticket.note']);

/** Record the intent, or return the existing operation for a repeated id (same user, same payload). */
export async function beginOperation(db: Pick<Pool, 'connect'>, id: string, userId: string, appKey: string, spec: ActionSpec, seal?: Sealer): Promise<{ row: Row; created: boolean }> {
 const payloadHash = hashOf(spec);
 return transaction(db, async tx => {
  const inserted = await tx.query(
   `INSERT INTO operations (id, user_id, app_key, operation, target_type, target_id, payload_hash, summary, state)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') ON CONFLICT (id) DO NOTHING RETURNING *`,
   [id, userId, appKey, spec.operation, spec.targetType, spec.targetId, payloadHash, JSON.stringify(spec.summary)]);
  if (inserted.rowCount) { await transition(tx, inserted.rows[0], 'pending', null, spec.summary, spec.content, seal); return { row: inserted.rows[0], created: true }; }
  const existing = (await tx.query('SELECT * FROM operations WHERE id = $1 FOR UPDATE', [id])).rows[0] as Row;
  if (existing.user_id !== userId || existing.payload_hash !== payloadHash) throw new OperationConflict('This operation id was used for a different action');
  return { row: existing, created: false };
 });
}

function classify(o: RpcOutcome<unknown>, keyed: boolean): { state: OperationState; code: string | null; record?: string; result?: Operation['result'] } {
 switch (o.kind) {
  case 'ok': {
   const d = o.data as { messageId?: string; id?: string; version?: number; status?: string; assigneeName?: string | null };
   return { state: 'succeeded', code: null, record: d.messageId ?? d.id,
    result: d.version !== undefined ? { version: d.version, status: d.status ?? null, assigneeName: d.assigneeName ?? null } : null };
  }
  case 'tool_error': return { state: o.code === 'FORBIDDEN' ? 'denied' : 'failed', code: o.code };
  case 'denied': return { state: 'denied', code: 'TENANT_DENIED' };
  case 'not_connected': return { state: 'failed', code: 'NOT_CONNECTED' };
  case 'reconnect_required': return { state: 'failed', code: 'RECONNECT_REQUIRED' };
  case 'not_sent': return { state: 'failed', code: 'NOT_SENT' };
  case 'unknown': return { state: 'uncertain', code: o.detail.toUpperCase() };
 }
 void keyed;
}

/** Dispatch (or re-dispatch, for a user-initiated retry of a keyed operation) and record the outcome. */
export async function dispatch(db: Pick<Pool, 'connect'> & Queryable, app: RegistryApp, row: Row, spec: ActionSpec): Promise<Row> {
 await db.query('UPDATE operations SET dispatched_at = now() WHERE id = $1', [row.id]);
 const args = spec.keyed ? { ...spec.args, operationKey: row.id } : spec.args;
 const outcome = await rpc(app, row.user_id, spec.tool, args as never, 6000);
 const c = classify(outcome, spec.keyed);
 return complete(db, row, c.state, c.code, c.record ?? null, c.result ?? null, { replayed: outcome.kind === 'ok' && (outcome.data as { replayed?: boolean }).replayed === true });
}

async function complete(db: Pick<Pool, 'connect'>, row: Pick<Row, 'id' | 'user_id' | 'app_key' | 'operation' | 'target_id'>, state: OperationState, code: string | null,
 record: string | null, result: Operation['result'], extra: Record<string, string | number | boolean | null> = {}): Promise<Row> {
 return transaction(db, async tx => {
  const updated = (await tx.query(
   `UPDATE operations SET state = $2, failure_code = $3, tenant_record_id = COALESCE($4, tenant_record_id), result = COALESCE($5, result),
     completed_at = CASE WHEN $2 IN ('succeeded', 'failed', 'denied') THEN now() ELSE completed_at END
    WHERE id = $1 RETURNING *`, [row.id, state, code, record, result ? JSON.stringify(result) : null])).rows[0];
  await transition(tx, row, state, code, { ...(record ? { tenantRecord: record } : {}), ...extra });
  return updated;
 });
}

/**
 * Ask the tenant what happened to an uncertain keyed operation. A committed result settles it; "unknown" leaves it
 * uncertain (the tenant may still commit a request it received late), and the user may retry with the same key.
 */
export async function reconcile(db: Pick<Pool, 'connect'> & Queryable, app: RegistryApp, row: Row): Promise<Row> {
 const o = await rpc(app, row.user_id, 'get_operation_result', { operationKey: row.id });
 if (o.kind === 'ok' && o.data.state === 'committed') return complete(db, row, 'succeeded', null, o.data.messageId, null, { reconciled: true });
 if (o.kind === 'ok') return complete(db, row, 'uncertain', 'NOT_COMMITTED_YET', null, null, { reconciled: true });
 return row;
}

export async function findOperation(db: Queryable, id: string, userId: string): Promise<Row | undefined> {
 return (await db.query('SELECT * FROM operations WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
}
