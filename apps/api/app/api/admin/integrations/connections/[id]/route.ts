import { pool } from '../../../../../../lib/db';
import { json } from '../../../../../../lib/http';
import { fieldProblem } from '../../../../../../lib/fleet-admin/http';
import { getConnection } from '../../../../../../lib/integrations/connections';
import { integrationAdmin } from '../../../../../../lib/integrations/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
 const { id } = await ctx.params;
 return integrationAdmin(request, 'observability.configure', async () => {
  const c = UUID.test(id) ? await getConnection(pool(), id) : null;
  return c ? json(c) : fieldProblem(404, 'NOT_FOUND', 'Connection not found.');
 });
}
