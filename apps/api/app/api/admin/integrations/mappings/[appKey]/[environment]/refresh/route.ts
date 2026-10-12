import { pool } from '../../../../../../../../lib/db';
import { json } from '../../../../../../../../lib/http';
import { fieldProblem } from '../../../../../../../../lib/fleet-admin/http';
import { refreshNow } from '../../../../../../../../lib/integrations/mappings';
import { integrationMutation } from '../../../../../../../../lib/integrations/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Poll an active mapping as soon as a worker is free. */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; environment: string }> }) {
 const { appKey, environment } = await ctx.params;
 return integrationMutation(request, 'observability.configure', async () =>
  (await refreshNow(pool(), appKey, environment)) ? json({ scheduled: true }) : fieldProblem(409, 'NOT_ACTIVE', 'Only an active mapping is polled.'));
}
