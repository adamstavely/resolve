import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalJson, type EvidenceFacts, type EvidenceSnapshot, type RegistryApp, type SubjectStatus } from '@resolve/contracts';
import { config } from '../config';
import type { Sealer } from '../crypto';
import { transaction, type Queryable } from '../db';
import { writeAudit } from '../audit';
import { beginOperation, dispatch, type ActionSpec } from '../operations';
import type { ToolFailure } from '../tenants/mcp';
import { actionSupported } from '../tenants/protocol';
import { fleetHealth } from './observability';
import { subjectContext } from './subject';

/*
 * Evidence snapshots (plan 12 §5, plan 14 E2; prototype board 4). An immutable record of what the person could see
 * when they captured it: service health, matching issues, the customer's events, and what was already tried in
 * Resolve. It is tied to the ticket or conversation, and an internal note linking to it is posted there as the
 * person (keyed, so a lost response is reconciled, never posted twice). The note carries the link, not the evidence.
 * A refresh is a new snapshot that points at the previous one. Every view re-checks access and re-verifies the hash.
 */

export const RETENTION_DAYS = 30;
const hash = (facts: EvidenceFacts) => createHash('sha256').update(canonicalJson(facts)).digest('hex');
const restrictedCount = (f: EvidenceFacts) => f.restricted.logs.length + f.restricted.traces.length + (f.restricted.patterns?.length ?? 0);

export class EvidenceError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }

interface Row {
 id: string; previous_id: string | null; app_key: string; environment: string; object_kind: 'ticket' | 'conversation'; object_id: string; subject_ref: string | null;
 requested_from: Date; requested_to: Date; facts: EvidenceFacts & { subjectStatus?: SubjectStatus }; completeness: EvidenceSnapshot['completeness'];
 classification: EvidenceSnapshot['classification']; content_hash: string; created_by: string; captured_at: Date; expires_at: Date;
 note_operation_key: string | null; note_state: EvidenceSnapshot['note']['state']; display_name?: string;
}

/** What was already tried on this object, from Resolve's own audit (actions, not reads). */
async function alreadyTried(db: Queryable, appKey: string, objectId: string): Promise<EvidenceFacts['alreadyTried']> {
 const rows = (await db.query(
  `SELECT a.at, a.operation, a.outcome, coalesce(u.display_name, 'system') AS actor FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
   WHERE a.summary->>'app' = $1 AND a.summary->>'target' = $2 AND (a.operation LIKE 'ticket.%' OR a.operation LIKE 'conversation.%') AND a.outcome <> 'pending'
   ORDER BY a.at DESC LIMIT 20`, [appKey, objectId])).rows as { at: Date; operation: string; outcome: string; actor: string }[];
 return rows.map(r => ({ at: r.at.toISOString(), operation: r.operation, actor: r.actor, outcome: r.outcome }));
}

export interface CaptureRequest { app: RegistryApp; userId: string; displayName: string; restricted: boolean; kind: 'ticket' | 'conversation'; id: string; requestId: string; previousId?: string }

export async function captureSnapshot(db: Pick<Pool, 'connect' | 'query'>, seal: Sealer, req: CaptureRequest): Promise<{ ok: true; id: string; created: boolean } | { ok: false; reason: ToolFailure }> {
 const existing = (await db.query('SELECT id, created_by FROM evidence_snapshots WHERE request_id = $1', [req.requestId])).rows[0];
 if (existing) {
  if (existing.created_by !== req.userId) throw new EvidenceError(409, 'REQUEST_REUSED', 'This request id was used by someone else.');
  return { ok: true, id: existing.id, created: false };
 }
 if (req.previousId) {
  const prev = (await db.query('SELECT app_key, object_kind, object_id FROM evidence_snapshots WHERE id = $1', [req.previousId])).rows[0];
  if (!prev || prev.app_key !== req.app.appKey || prev.object_kind !== req.kind || prev.object_id !== req.id) throw new EvidenceError(400, 'INVALID_PREVIOUS', 'A refresh must follow a snapshot of the same item.');
 }
 const out = await subjectContext(db, seal, { app: req.app, userId: req.userId, restricted: req.restricted, kind: req.kind, id: req.id });
 if (!out.ok) return out;
 const ctx = out.context;
 if (!out.mapping) throw new EvidenceError(409, 'NOT_MAPPED', 'This application is not connected to Elastic, so there is no evidence to capture.');
 const health = (await fleetHealth(db, [req.app], config().OBSERVABILITY_POLL_SECONDS)).find(h => h.environment === out.mapping!.environment) ?? null;
 const facts: EvidenceFacts = {
  health, issues: ctx.matchedIssues, events: ctx.events.map(e => ({ ...e, traceId: null, transactionId: null })), lastSession: ctx.lastSession,
  synthetics: ctx.synthetics, alreadyTried: await alreadyTried(db, req.app.appKey, req.id),
  restricted: req.restricted
   ? { logs: ctx.logs, traces: ctx.events.filter(e => e.traceId).map(e => ({ traceId: e.traceId!, transactionId: e.transactionId, at: e.at })), patterns: ctx.patterns }
   : { logs: [], traces: [] },
 };
 const classification = restrictedCount(facts) ? 'restricted' : ctx.subject.status === 'verified' ? 'subject' : 'service';
 const id = randomUUID();
 const noteKey = randomUUID();
 const capturedAt = new Date();
 await transaction(db, async tx => {
  await tx.query(
   `INSERT INTO evidence_snapshots (id, previous_id, app_key, environment, object_kind, object_id, subject_ref, requested_from, requested_to, source_from, source_to,
     facts, source_ids, query_revision, completeness, classification, content_hash, created_by, request_id, captured_at, expires_at, note_operation_key, note_state)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'pending')`,
   [id, req.previousId ?? null, req.app.appKey, out.mapping!.environment, req.kind, req.id,
    ctx.subject.externalId ? createHash('sha256').update(`${req.app.appKey}|${ctx.subject.externalId}`).digest('hex') : null,
    ctx.window.from, ctx.window.to, JSON.stringify({ ...facts, subjectStatus: ctx.subject.status }),
    JSON.stringify({ issues: facts.issues.map(i => i.providerId), traces: facts.restricted.traces.map(t => t.traceId) }),
    `mapping:${out.mapping!.revision}`, ctx.completeness, classification, hash(facts), req.userId, req.requestId, capturedAt,
    new Date(capturedAt.getTime() + RETENTION_DAYS * 86_400_000), noteKey]);
  await writeAudit(tx, { actorUserId: req.userId, operation: 'observability.snapshot_capture', outcome: 'succeeded',
   summary: { app: req.app.appKey, target: req.id, kind: req.kind, snapshot: id, classification, events: facts.events.length, issues: facts.issues.length, refresh: !!req.previousId } });
 });
 await postNote(db, req, id, noteKey, capturedAt, facts);
 return { ok: true, id, created: true };
}

/** The internal note: a link and a one-line summary, posted as the person with an operation key. */
async function postNote(db: Pick<Pool, 'connect' | 'query'>, req: CaptureRequest, id: string, noteKey: string, capturedAt: Date, facts: EvidenceFacts) {
 const tool = req.kind === 'ticket' ? 'add_ticket_note' : 'add_conversation_note';
 if (!(await actionSupported(req.app, tool))) { await db.query(`UPDATE evidence_snapshots SET note_state = 'failed' WHERE id = $1`, [id]); return; }
 const content = `Evidence snapshot captured by ${req.displayName} at ${capturedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC: ${config().RESOLVE_ORIGIN}/evidence/${id}`
  + ` (service ${facts.health?.state ?? 'unknown'}; ${facts.events.length} customer events; ${facts.issues.length} known issues). The evidence stays in Resolve.`;
 const spec: ActionSpec = {
  operation: `${req.kind}.note`, tool, keyed: true, targetType: req.kind, targetId: req.id,
  args: req.kind === 'ticket' ? { ticketId: req.id, content } : { conversationId: req.id, content },
  summary: { kind: 'note', characters: content.length, files: null, snapshot: id }, content,
 };
 const { row } = await beginOperation(db, noteKey, req.userId, req.app.appKey, spec);
 const done = await dispatch(db as Pick<Pool, 'connect'> & Queryable, req.app, row, spec);
 await db.query('UPDATE evidence_snapshots SET note_state = $2 WHERE id = $1', [id, done.state === 'denied' ? 'failed' : done.state]);
}

/** A snapshot as this viewer may see it. Restricted items are hidden, and counted, for everyone without the capability. */
export function snapshotView(r: Row, restricted: boolean): EvidenceSnapshot {
 const { subjectStatus, ...stored } = r.facts;
 const facts: EvidenceFacts = stored;
 const hidden = restricted ? 0 : restrictedCount(facts);
 return {
  id: r.id, previousId: r.previous_id, appKey: r.app_key, environment: r.environment, objectKind: r.object_kind, objectId: r.object_id,
  subjectStatus: subjectStatus ?? 'not_reported', requested: { from: r.requested_from.toISOString(), to: r.requested_to.toISOString() },
  capturedAt: r.captured_at.toISOString(), capturedBy: r.display_name ?? 'Unknown', expiresAt: r.expires_at.toISOString(),
  completeness: r.completeness, classification: r.classification, contentHash: r.content_hash, hashVerified: hash(facts) === r.content_hash,
  facts: restricted ? facts : { ...facts, restricted: { logs: [], traces: [] } }, hiddenRestricted: hidden,
  note: { state: r.note_state, operationId: r.note_operation_key },
 };
}

export async function loadSnapshot(db: Queryable, id: string): Promise<Row | null> {
 return ((await db.query(`SELECT s.*, u.display_name FROM evidence_snapshots s JOIN users u ON u.id = s.created_by WHERE s.id = $1 AND (s.expires_at > now() OR s.hold)`, [id])).rows[0] as Row | undefined) ?? null;
}

export async function snapshotsFor(db: Queryable, appKey: string, kind: string, objectId: string) {
 return (await db.query(`SELECT s.id, s.captured_at, s.classification, s.note_state, u.display_name FROM evidence_snapshots s JOIN users u ON u.id = s.created_by
  WHERE s.app_key = $1 AND s.object_kind = $2 AND s.object_id = $3 AND (s.expires_at > now() OR s.hold) ORDER BY s.captured_at DESC LIMIT 20`, [appKey, kind, objectId])).rows
  .map(r => ({ id: r.id as string, capturedAt: (r.captured_at as Date).toISOString(), classification: r.classification as string, noteState: r.note_state as string | null, capturedBy: r.display_name as string }));
}

