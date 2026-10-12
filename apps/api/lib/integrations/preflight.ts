import type { Pool } from 'pg';
import {
 ACTION_POLICIES, ACTION_POLICY_VERSION, PREFLIGHT_TTL_SECONDS, type AppHealth, type Preflight, type PreflightAction, type RegistryApp, type SubjectContext,
} from '@resolve/contracts';
import { config } from '../config';
import type { Sealer } from '../crypto';
import type { Queryable } from '../db';
import { writeAudit } from '../audit';
import type { ToolFailure } from '../tenants/mcp';
import { fleetHealth } from './observability';
import { subjectContext } from './subject';

/*
 * Pre-flight checks (plan 12 §7, plan 14 E3; prototype board 3). Before a gated action, Resolve combines the action's
 * policy, the customer, current service health, known issues and synthetic checks into allow / warn / block / unknown,
 * shows it, and stores it. At dispatch the stored result is used only while fresh and for the same person, target and
 * action; otherwise it is evaluated again. An advisory warning may be overridden with a reason (audited). A block may
 * not. Nothing here grants or replaces a permission: the tenant still decides.
 */

type Check = Preflight['checks'][number];

/** Pure: the policy decision from what was observed. */
export function decide(action: PreflightAction, health: AppHealth | null, ctx: SubjectContext | null): Pick<Preflight, 'outcome' | 'checks' | 'conclusion' | 'suggestedIssue'> {
 const policy = ACTION_POLICIES[action];
 const checks: Check[] = [];
 // 1. Service health.
 if (!health || health.reason || health.state === 'unknown' || health.state === 'stale') {
  checks.push({ state: 'unknown', title: 'Service health is not known', detail: health?.reason === 'not_configured' ? 'This application is not connected to Elastic.' : health?.state === 'stale' ? 'The last health check is out of date.' : 'No current health check.', sources: ['SLO', 'ALERTS'] });
 } else if (health.state === 'healthy') {
  checks.push({ state: 'ok', title: 'Services are healthy', detail: 'SLOs within budget and no active alerts on the mapped rules.', sources: ['SLO', 'ALERTS'] });
 } else {
  const b = health.summary.slos.worstBurn;
  checks.push({ state: 'bad', title: `The application is ${health.state}`, sources: ['APM', 'SLO', 'ALERTS'],
   detail: [b ? `${b.name} burning ${b.value.toFixed(1)}x over ${b.window}.` : '', health.summary.activeAlerts ? `${health.summary.activeAlerts} active alert${health.summary.activeAlerts === 1 ? '' : 's'}.` : ''].filter(Boolean).join(' ') || 'Elastic reports degraded service.' });
 }
 // 2. Known issues and this customer.
 const issue = ctx?.matchedIssues.find(i => i.customerErrorsInWindow > 0) ?? null;
 if (!ctx || ctx.subject.status !== 'verified') {
  checks.push({ state: 'unknown', title: "Whether a known issue affects this customer", detail: 'The application did not identify this customer, so their errors cannot be compared.', sources: ['APM'] });
 } else if (issue) {
  checks.push({ state: 'warn', title: `Matches known issue ${issue.kind === 'case' ? issue.providerId : '(active alert)'}`, sources: ['APM', issue.kind === 'case' ? 'CASES' : 'ALERTS'],
   detail: `${issue.title}. ${issue.customerErrorsInWindow} of this customer's errors fall inside its window.` });
 } else {
  checks.push({ state: 'ok', title: 'No known issue touches this customer', detail: ctx.matchedIssues.length ? `${ctx.matchedIssues.length} issue${ctx.matchedIssues.length === 1 ? ' is' : 's are'} active, with no errors from this customer since ${ctx.matchedIssues.length === 1 ? 'it' : 'they'} began.` : 'No active issue in this application.', sources: ['APM'] });
 }
 // 3. Synthetic checks.
 const failing = ctx?.synthetics.filter(s => s.status === 'down') ?? [];
 if (!ctx || ctx.synthetics.length === 0) checks.push({ state: 'unknown', title: 'Synthetic checks', detail: 'No synthetic results in the last 15 minutes.', sources: ['SYNTHETICS'] });
 else if (failing.length) checks.push({ state: 'warn', title: `${failing.map(f => `${f.name} (${f.location})`).join(', ')} failing`, detail: 'Failing for everyone, on the latest run.', sources: ['SYNTHETICS'] });
 else checks.push({ state: 'ok', title: 'Synthetic checks pass', detail: `${ctx.synthetics.length} locations passing on the latest run.`, sources: ['SYNTHETICS'] });

 const suggestedIssue = issue ? { issueId: issue.issueId, title: issue.title, kind: issue.kind, providerId: issue.providerId } : null;
 if (issue) return { outcome: 'warn', checks, suggestedIssue,
  conclusion: `Link it to the known issue instead. You will be told when the issue clears, so you can come back to it.` };
 const unknown = checks.some(c => c.state === 'unknown');
 return { outcome: unknown ? (policy.refuseUnknown ? 'block' : 'unknown') : 'allow', checks, suggestedIssue: null, conclusion: unknown ? 'Some checks could not be made. This action is low impact, so you can go ahead.' : null };
}

export interface PreflightRequest { app: RegistryApp; userId: string; kind: 'ticket' | 'conversation'; id: string; action: PreflightAction }

export async function evaluate(db: Pick<Pool, 'connect' | 'query'>, seal: Sealer, req: PreflightRequest, now = new Date()): Promise<{ ok: true; preflight: Preflight } | { ok: false; reason: ToolFailure }> {
 const out = await subjectContext(db, seal, { app: req.app, userId: req.userId, restricted: false, kind: req.kind, id: req.id }, now);
 if (!out.ok) return out;
 const health = (await fleetHealth(db, [req.app], config().OBSERVABILITY_POLL_SECONDS, now.getTime()))[0] ?? null;
 const d = decide(req.action, health, out.context);
 const policy = ACTION_POLICIES[req.action];
 const expiresAt = new Date(now.getTime() + PREFLIGHT_TTL_SECONDS * 1000);
 const row = (await db.query(
  `INSERT INTO action_preflights (user_id, app_key, object_kind, object_id, action, outcome, checks, evidence, policy_version, evaluated_at, expires_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
  [req.userId, req.app.appKey, req.kind, req.id, req.action, d.outcome, JSON.stringify(d.checks),
   JSON.stringify({ health: health?.state ?? null, healthFetchedAt: health?.provenance?.fetchedAt ?? null, issue: d.suggestedIssue?.providerId ?? null, subject: out.context.subject.status }),
   ACTION_POLICY_VERSION, now, expiresAt])).rows[0];
 return { ok: true, preflight: {
  id: row.id, action: req.action, appKey: req.app.appKey, objectKind: req.kind, objectId: req.id, impact: policy.impact, ...d,
  customer: { externalId: out.context.subject.externalId, status: out.context.subject.status }, overridable: policy.overridable,
  policyVersion: ACTION_POLICY_VERSION, evaluatedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
 } };
}

export class PreflightRefused extends Error {
 constructor(readonly status: number, readonly code: string, message: string, readonly preflight: Preflight | null = null) { super(message); }
}

/**
 * The gate at dispatch. Uses the stored pre-flight when it is fresh and belongs to this person, target and action;
 * otherwise evaluates again (a stale screen never authorizes anything). Returns the pre-flight id to bind to the operation.
 */
export async function gate(db: Pick<Pool, 'connect' | 'query'>, seal: Sealer, req: PreflightRequest, preflightId: string | undefined, override: { reason: string } | undefined): Promise<string> {
 let id = preflightId; let outcome: string | undefined; let fresh: Preflight | null = null;
 if (id) {
  const r = (await db.query(`SELECT id, outcome, expires_at, used_at FROM action_preflights WHERE id = $1 AND user_id = $2 AND app_key = $3 AND object_kind = $4 AND object_id = $5 AND action = $6`,
   [id, req.userId, req.app.appKey, req.kind, req.id, req.action])).rows[0];
  if (r && !r.used_at && (r.expires_at as Date) > new Date()) outcome = r.outcome; else id = undefined;
 }
 if (!id) {
  const e = await evaluate(db, seal, req);
  if (!e.ok) throw new PreflightRefused(e.reason === 'not_found' ? 404 : 403, e.reason.toUpperCase(), 'You do not have access to this.');
  fresh = e.preflight; id = fresh.id; outcome = fresh.outcome;
 }
 if (outcome === 'block') throw new PreflightRefused(409, 'PREFLIGHT_BLOCKED', 'The pre-flight check blocks this action.', fresh);
 if (outcome === 'warn') {
  // A fresh evaluation the person has not seen cannot be overridden blind.
  if (!override || fresh) throw new PreflightRefused(409, 'PREFLIGHT_WARNING', 'The pre-flight check found a known issue affecting this customer. Review it before going ahead.', fresh);
  if (!ACTION_POLICIES[req.action].overridable) throw new PreflightRefused(409, 'PREFLIGHT_BLOCKED', 'This warning cannot be overridden.');
  await db.query('UPDATE action_preflights SET override_reason = $2 WHERE id = $1', [id, override.reason]);
  await writeAudit(db as Queryable, { actorUserId: req.userId, operation: 'observability.preflight_override', outcome: 'succeeded',
   summary: { app: req.app.appKey, target: req.id, action: req.action, preflight: id, reason: override.reason } });
 }
 return id!;
}

/** Bind the pre-flight to the operation it allowed (it cannot be reused). */
export async function bindPreflight(db: Queryable, preflightId: string, operationId: string) {
 await db.query('UPDATE action_preflights SET operation_id = $2, used_at = now() WHERE id = $1 AND used_at IS NULL', [preflightId, operationId]);
}
