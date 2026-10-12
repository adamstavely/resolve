import { activateSchema } from '@resolve/contracts';
import { pool } from '../../../../../../lib/db';
import { json } from '../../../../../../lib/http';
import { adminMutation, fieldProblem } from '../../../../../../lib/fleet-admin/http';
import { activate, runView } from '../../../../../../lib/fleet-admin/onboarding';
import { toView } from '../../../../../../lib/fleet-admin/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Dispatch activate for the reviewed revision. The request id makes a repeated submit the same job. */
export async function POST(request: Request, ctx: { params: Promise<{ runId: string }> }) {
 const { runId } = await ctx.params;
 return adminMutation(request, 'app.activate', async (principal, raw) => {
  const body = activateSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', 'Send the reviewed configuration revision and a request id.');
  const job = await activate(pool(), principal.userId, runId, body.data);
  return json({ job: toView(job), run: await runView(pool(), runId) }, 202);
 });
}
