import { randomUUID } from 'node:crypto';
import type { JobCheck } from '@resolve/contracts';
import { pool } from '../db';
import { sealer } from '../sealer';
import type { Principal } from '../auth/session';
import { rawRegistryApp } from '../registry';
import { accessToken } from '../tenants/grants';
import { refresher } from '../tenants/oauth';
import { rpc } from '../tenants/mcp';
import { beginOperation, dispatch as dispatchOperation } from '../operations';
import { OnboardingError, pilotRun, recordPilot, runView } from './onboarding';

/*
 * Pilot check (plan 07 step 6): a real, named person exercises the instance through Resolve before activation:
 * their own SSO connection, a read, and a permitted action that is attributed to them in both Resolve's audit and the
 * tenant. Nothing here is simulated; if they are not connected, the check says so.
 */
export async function runPilotCheck(principal: Principal, runId: string) {
 const run = await runView(pool(), runId);
 const pilot = run.workspaceKey ? await pilotRun(pool(), principal.userId, run.workspaceKey) : undefined;
 if (!pilot || pilot.id !== runId) throw new OnboardingError(403, 'NOT_PILOT', 'You are not a pilot for this onboarding run, or it is not being validated.');
 if (!run.configRevision || run.status !== 'ready') throw new OnboardingError(409, 'NOT_READY', 'The pilot check runs after validation passes.');
 const app = await rawRegistryApp(run.workspaceKey!).catch(() => undefined);
 if (!app) throw new OnboardingError(503, 'APP_UNAVAILABLE', 'The instance is not in the registry yet.');
 const checks: JobCheck[] = [];
 const add = (id: string, label: string, ok: boolean, detail: string | null = null) => { checks.push({ id, label, required: true, status: ok ? 'passed' : 'failed', detail }); return ok; };

 const token = await accessToken(pool(), sealer(), principal.userId, app.appKey, refresher(app));
 if (add('pilot.connect', 'Signed in to the instance through SSO and connected Resolve', token.status === 'ok', token.status === 'ok' ? null : 'Connect to the instance first')) {
  const list = await rpc(app, principal.userId, 'list_conversations', { status: 'open', limit: 5 });
  const conversations = list.kind === 'ok' ? list.data.conversations : [];
  if (add('pilot.read', 'Read the support queue with your own access', list.kind === 'ok', list.kind === 'ok' ? null : `The instance refused the read (${list.kind === 'tool_error' ? list.code : list.kind})`)) {
   const target = conversations[0];
   if (!target) add('pilot.action', 'Added an internal note as yourself', false, 'No conversation to write to');
   else {
    // A recorded, keyed operation, exactly like an agent's note: audited in Resolve and attributed to the pilot in the tenant.
    const spec = { operation: 'conversation.note', tool: 'add_conversation_note' as const, targetType: 'conversation' as const, targetId: target.id, keyed: true,
     args: { conversationId: target.id, content: `Resolve pilot check by ${principal.displayName}` }, summary: { kind: 'note', pilotRun: runId }, content: `Resolve pilot check by ${principal.displayName}` };
    const { row } = await beginOperation(pool(), randomUUID(), principal.userId, app.appKey, spec);
    const done = await dispatchOperation(pool(), app, row, spec);
    add('pilot.action', 'Added an internal note as yourself', done.state === 'succeeded', done.state === 'succeeded' ? `Tenant record ${done.tenant_record_id}` : `Not applied (${done.failure_code ?? done.state})`);
   }
  }
 }
 const passed = await recordPilot(pool(), runId, principal.userId, run.configRevision, checks.map(c => ({ ...c, status: c.status as 'passed' | 'failed' })));
 return { passed, checks };
}
