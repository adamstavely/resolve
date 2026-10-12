import { lifecycleChangeSchema } from '@resolve/contracts';
import { pool } from '../../../../../../lib/db';
import { json } from '../../../../../../lib/http';
import { registry, resetRegistryCache } from '../../../../../../lib/registry';
import { adminMutation, fieldProblem } from '../../../../../../lib/fleet-admin/http';
import { dispatch, startJob, toView } from '../../../../../../lib/fleet-admin/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Suspend an instance: the fleet stops routing it and ends open connections; nothing is deleted. */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string }> }) {
 const { appKey } = await ctx.params;
 return adminMutation(request, 'app.lifecycle', async (principal, raw) => {
  const body = lifecycleChangeSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', 'Send a request id and a reason.');
  resetRegistryCache(); // decide on the fleet's current state, not a cached one
  const app = (await registry(fetch, false).catch(() => ({ apps: [] as { appKey: string; state: string }[] }))).apps.find(a => a.appKey === appKey);
  if (!app) return fieldProblem(404, 'NOT_FOUND', 'Unknown application.');
  if (app.state !== 'active') return fieldProblem(409, 'INVALID_STATE', 'Only an active instance can be suspended.');
  const r = await startJob(pool(), { appKey, command: 'suspend', parameters: { reason: body.data.reason ?? 'operator' }, initiatorUserId: principal.userId, requestId: body.data.requestId });
  if (r.kind === 'conflict') return fieldProblem(409, r.code, r.code === 'APP_BUSY' ? 'Another job is running for this application.' : 'This request id was used for something else.');
  return json({ job: toView(await dispatch(pool(), r.job)) }, 202);
 });
}
