import { mappingStateRequestSchema } from '@resolve/contracts';
import { pool } from '../../../../../../../../lib/db';
import { json } from '../../../../../../../../lib/http';
import { fieldProblem } from '../../../../../../../../lib/fleet-admin/http';
import { setMappingState } from '../../../../../../../../lib/integrations/mappings';
import { integrationMutation } from '../../../../../../../../lib/integrations/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Activate (after both checks pass) or disable a mapping. */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; environment: string }> }) {
 const { appKey, environment } = await ctx.params;
 return integrationMutation(request, 'observability.configure', async (principal, raw) => {
  const body = mappingStateRequestSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', 'Choose active or disabled.');
  return json(await setMappingState(pool(), principal.userId, appKey, environment, body.data.state, body.data.version));
 });
}
