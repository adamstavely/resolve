import { evidenceCaptureSchema, summaryFeedbackSchema, type CapabilityId } from '@resolve/contracts';
import { config } from '../config';
import { pool } from '../db';
import { json, jsonMutation, problem } from '../http';
import { sealer } from '../sealer';
import { auditRead, writeAudit } from '../audit';
import { appRequest, toolFailure } from '../fleet/http';
import { callTenantTool } from '../tenants/mcp';
import { captureSnapshot, EvidenceError, loadSnapshot, snapshotsFor, snapshotView } from './evidence';
import { subjectContext } from './subject';
import { generateSummary, latestSummary, recordFeedback } from './summary';

/*
 * HTTP for customer context and evidence (plan 14, E2), shared by the ticket and conversation routes. Order: capability,
 * then the application, then the person's own access to the object (checked by the tenant), and only then Elastic.
 */
type Kind = 'ticket' | 'conversation';
const READ: Record<Kind, CapabilityId> = { ticket: 'ticket.read', conversation: 'chat.read' };

export async function subjectContextResponse(request: Request, appKey: string, kind: Kind, id: string) {
 const r = await appRequest(request, 'observability.subject', appKey, 'read.observability_subject');
 if (r instanceof Response) return r;
 if (!r.principal.capabilities.includes(READ[kind])) return problem(403, 'FORBIDDEN', 'You do not have access to this.');
 const restricted = r.principal.capabilities.includes('observability.restricted');
 const out = await subjectContext(pool(), sealer(), { app: r.app, userId: r.principal.userId, restricted, kind, id });
 if (!out.ok) { await auditRead(r.principal, 'observability_subject', { app: appKey, target: id, code: out.reason }, 'denied'); return toolFailure(out.reason); }
 const c = out.context;
 await auditRead(r.principal, 'observability_subject', { app: appKey, target: id, kind, subject: c.subject.status, events: c.events.length });
 // Restricted reads (trace ids, log lines) are audited separately, with their source.
 if (restricted && (c.logs.length || c.events.some(e => e.traceId)))
  await writeAudit(pool(), { actorUserId: r.principal.userId, operation: 'observability.restricted_read', outcome: 'succeeded',
   summary: { app: appKey, target: id, source: 'elastic', logs: c.logs.length, traces: c.events.filter(e => e.traceId).length } });
 return json(c);
}

export async function captureResponse(request: Request, appKey: string, kind: Kind, id: string) {
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const r = await appRequest(request, 'observability.link', appKey, 'observability.snapshot_capture');
 if (r instanceof Response) return r;
 if (!r.principal.capabilities.includes('observability.subject') || !r.principal.capabilities.includes(READ[kind])) return problem(403, 'FORBIDDEN', 'You do not have access to this.');
 const body = evidenceCaptureSchema.safeParse(raw);
 if (!body.success) return problem(400, 'INVALID_REQUEST', 'Send a request id.');
 try {
  const out = await captureSnapshot(pool(), sealer(), { app: r.app, userId: r.principal.userId, displayName: r.principal.displayName, restricted: r.principal.capabilities.includes('observability.restricted'),
   kind, id, requestId: body.data.requestId, previousId: body.data.previousId });
  if (!out.ok) return toolFailure(out.reason);
  const row = (await loadSnapshot(pool(), out.id))!;
  return json(snapshotView(row, r.principal.capabilities.includes('observability.restricted')), out.created ? 201 : 200);
 } catch (e) { if (e instanceof EvidenceError) return problem(e.status, e.code, e.message); throw e; }
}

export async function snapshotListResponse(request: Request, appKey: string, kind: Kind, id: string) {
 const r = await appRequest(request, 'observability.subject', appKey, 'read.snapshots');
 if (r instanceof Response) return r;
 if (!r.principal.capabilities.includes(READ[kind])) return problem(403, 'FORBIDDEN', 'You do not have access to this.');
 const seen = kind === 'ticket' ? await callTenantTool(r.app, r.principal.userId, 'get_ticket', { ticketId: id }) : await callTenantTool(r.app, r.principal.userId, 'get_conversation', { conversationId: id });
 if (!seen.ok) return toolFailure(seen.reason);
 return json({ snapshots: await snapshotsFor(pool(), appKey, kind, id) });
}

/** A snapshot as this person may see it, after re-checking access to its item with the tenant. */
async function visibleSnapshot(request: Request, snapshotId: string) {
 if (!/^[0-9a-f-]{36}$/.test(snapshotId)) return problem(404, 'NOT_FOUND', 'Snapshot not found.');
 const row = await loadSnapshot(pool(), snapshotId);
 if (!row) return problem(404, 'NOT_FOUND', 'Snapshot not found, or it has expired.');
 const r = await appRequest(request, 'observability.subject', row.app_key, 'read.snapshot');
 if (r instanceof Response) return r;
 if (!r.principal.capabilities.includes(READ[row.object_kind])) return problem(404, 'NOT_FOUND', 'Snapshot not found, or it has expired.');
 const seen = row.object_kind === 'ticket' ? await callTenantTool(r.app, r.principal.userId, 'get_ticket', { ticketId: row.object_id }) : await callTenantTool(r.app, r.principal.userId, 'get_conversation', { conversationId: row.object_id });
 // A snapshot is as private as the item it belongs to.
 if (!seen.ok) { await auditRead(r.principal, 'snapshot', { snapshot: snapshotId, code: seen.reason }, 'denied'); return problem(404, 'NOT_FOUND', 'Snapshot not found, or it has expired.'); }
 const restricted = r.principal.capabilities.includes('observability.restricted');
 return { principal: r.principal, row, restricted, view: snapshotView(row, restricted) };
}

/** View (or, for observability.restricted, export) a snapshot. Access to the item is re-checked every time. */
export async function snapshotResponse(request: Request, snapshotId: string, download: boolean) {
 const v = await visibleSnapshot(request, snapshotId);
 if (v instanceof Response) return v;
 if (download && !v.restricted) return problem(403, 'FORBIDDEN', 'Exporting snapshots needs the investigator role.');
 await auditRead(v.principal, download ? 'snapshot_export' : 'snapshot', { snapshot: snapshotId, app: v.row.app_key, target: v.row.object_id, classification: v.row.classification, hidden: v.view.hiddenRestricted });
 if (download) return new Response(JSON.stringify(v.view, null, 1), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="evidence-${snapshotId}.json"`, 'Cache-Control': 'no-store' } });
 return json(v.view);
}

const modelConfig = () => ({ url: config().SUMMARY_MODEL_URL ?? null, name: config().SUMMARY_MODEL_NAME, timeoutMs: 20_000 });

/** The latest draft summary this person may see (E4). */
export async function summaryResponse(request: Request, snapshotId: string) {
 const v = await visibleSnapshot(request, snapshotId);
 if (v instanceof Response) return v;
 const s = await latestSummary(pool(), snapshotId, v.principal.userId, v.restricted);
 return json({ ...s, modelConfigured: !!config().SUMMARY_MODEL_URL });
}

/** Draft a summary from the facts this person can see. Agents and investigators only (observability.link). */
export async function draftSummaryResponse(request: Request, snapshotId: string) {
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const v = await visibleSnapshot(request, snapshotId);
 if (v instanceof Response) return v;
 if (!v.principal.capabilities.includes('observability.link')) return problem(403, 'FORBIDDEN', 'You do not have access to this.');
 await generateSummary(pool(), modelConfig(), v.view, v.principal.userId, v.restricted);
 return json({ ...(await latestSummary(pool(), snapshotId, v.principal.userId, v.restricted)), modelConfigured: !!config().SUMMARY_MODEL_URL }, 201);
}

export async function summaryFeedbackResponse(request: Request, snapshotId: string, summaryId: string) {
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const v = await visibleSnapshot(request, snapshotId);
 if (v instanceof Response) return v;
 const body = summaryFeedbackSchema.safeParse(raw);
 if (!body.success || !/^[0-9a-f-]{36}$/.test(summaryId)) return problem(400, 'INVALID_REQUEST', 'Choose accurate or something is off.');
 const owns = (await pool().query('SELECT 1 FROM evidence_summaries WHERE id = $1 AND snapshot_id = $2', [summaryId, snapshotId])).rowCount;
 if (!owns) return problem(404, 'NOT_FOUND', 'Summary not found.');
 await recordFeedback(pool(), summaryId, v.principal.userId, body.data.verdict, body.data.note);
 return json({ recorded: true });
}
