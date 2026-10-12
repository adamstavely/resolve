import { randomUUID } from 'node:crypto';
import { aad, type Sealer } from './crypto';
import { pool, type Queryable } from './db';
import { sealer } from './sealer';
import type { Principal } from './auth/session';

/*
 * Audit trail (owner decision 2026-10-12): every user event is recorded: sign-in, connections, every read,
 * every refused request, every action, and the full text of messages sent. Message text is sealed and bound to
 * its event id; only the audit API (audit.read) opens it. Retention for audit content is still an open input.
 */
export type AuditOutcome = 'pending' | 'succeeded' | 'failed' | 'uncertain' | 'denied';
type Summary = Record<string, string | number | boolean | null>;

export interface AuditEntry {
 actorUserId: string | null;
 operation: string;
 outcome: AuditOutcome;
 summary?: Summary;
 /** Links the transitions of one operation (defaults to a new id). */
 operationId?: string;
 /** Message text sent by the user, stored sealed. */
 content?: string;
}

export async function writeAudit(db: Queryable, e: AuditEntry, seal: Sealer | (() => Sealer) = sealer) {
 const id = randomUUID();
 const contentEnc = e.content === undefined ? null : (typeof seal === 'function' ? seal() : seal).seal(e.content, aad.auditContent(id));
 await db.query('INSERT INTO audit_events (id, operation_id, actor_user_id, operation, outcome, summary, content_enc) VALUES ($1, $2, $3, $4, $5, $6, $7)',
  [id, e.operationId ?? randomUUID(), e.actorUserId, e.operation, e.outcome, JSON.stringify(e.summary ?? {}), contentEnc]);
}

/** A read by a signed-in person (lists, dashboards, opening a record, checks). */
export function auditRead(principal: Principal, operation: string, summary: Summary = {}, outcome: AuditOutcome = 'succeeded') {
 return writeAudit(pool(), { actorUserId: principal.userId, operation: `read.${operation}`, outcome, summary });
}

/** A refused request: unauthenticated, missing capability, cross-origin. */
export function auditDenied(request: Request, actorUserId: string | null, reason: string, extra: Summary = {}) {
 const url = new URL(request.url);
 return writeAudit(pool(), { actorUserId, operation: 'access.denied', outcome: 'denied', summary: { method: request.method, path: url.pathname, reason, ...extra } });
}
