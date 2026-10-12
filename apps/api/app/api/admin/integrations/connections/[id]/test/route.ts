import { pool } from '../../../../../../../lib/db';
import { json } from '../../../../../../../lib/http';
import { sealer } from '../../../../../../../lib/sealer';
import { fieldProblem } from '../../../../../../../lib/fleet-admin/http';
import { testConnection } from '../../../../../../../lib/integrations/connections';
import { integrationMutation } from '../../../../../../../lib/integrations/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Discovery: versions and one probe per API family, recorded on the connection. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
 const { id } = await ctx.params;
 return integrationMutation(request, 'observability.configure', async principal => {
  if (!/^[0-9a-f-]{36}$/.test(id)) return fieldProblem(404, 'NOT_FOUND', 'Connection not found.');
  return json(await testConnection(pool(), sealer(), principal.userId, id));
 });
}
