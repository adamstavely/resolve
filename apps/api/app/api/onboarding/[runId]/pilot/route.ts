import { pool } from '../../../../../lib/db';
import { json, jsonMutation } from '../../../../../lib/http';
import { requireCapability } from '../../../../../lib/auth/session';
import { fieldProblem } from '../../../../../lib/fleet-admin/http';
import { OnboardingError, pilotRun, runView } from '../../../../../lib/fleet-admin/onboarding';
import { runPilotCheck } from '../../../../../lib/fleet-admin/pilot-check';
import { auditRead } from '../../../../../lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What a pilot needs: the instance, whether they are connected, and their checks. Pilots need not be admins. */
export async function GET(request: Request, ctx: { params: Promise<{ runId: string }> }) {
 const { runId } = await ctx.params;
 const principal = await requireCapability(request, 'connection.manage');
 if (principal instanceof Response) return principal;
 try {
  const run = await runView(pool(), runId);
  const pilot = run.workspaceKey ? await pilotRun(pool(), principal.userId, run.workspaceKey) : undefined;
  if (!pilot || pilot.id !== runId) return fieldProblem(403, 'NOT_PILOT', 'You are not a pilot for this onboarding run.');
  const grant = (await pool().query('SELECT state FROM user_tenant_grants WHERE user_id = $1 AND app_key = $2', [principal.userId, run.workspaceKey])).rows[0];
  await auditRead(principal, 'pilot', { runId });
  return json({ runId, applicationName: run.applicationName, environment: run.environment, workspaceKey: run.workspaceKey, status: run.status,
   configRevision: run.configRevision, connected: grant?.state === 'connected', checks: run.pilot.filter(p => p.userId === principal.userId) });
 } catch (e) { if (e instanceof OnboardingError) return fieldProblem(e.status, e.code, e.message); throw e; }
}

/** Run the pilot check as yourself. */
export async function POST(request: Request, ctx: { params: Promise<{ runId: string }> }) {
 const { runId } = await ctx.params;
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const principal = await requireCapability(request, 'connection.manage');
 if (principal instanceof Response) return principal;
 try { return json(await runPilotCheck(principal, runId)); }
 catch (e) { if (e instanceof OnboardingError) return fieldProblem(e.status, e.code, e.message); throw e; }
}
