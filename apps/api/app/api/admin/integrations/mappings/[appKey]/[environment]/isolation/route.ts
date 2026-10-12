import { pool } from '../../../../../../../../lib/db';
import { json } from '../../../../../../../../lib/http';
import { sealer } from '../../../../../../../../lib/sealer';
import { isolationCheck } from '../../../../../../../../lib/integrations/mappings';
import { integrationMutation } from '../../../../../../../../lib/integrations/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Check that this mapping shares no events or ids with any other app's mapping on the same connection. */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; environment: string }> }) {
 const { appKey, environment } = await ctx.params;
 return integrationMutation(request, 'observability.configure', async principal => json(await isolationCheck(pool(), sealer(), principal.userId, appKey, environment)));
}
