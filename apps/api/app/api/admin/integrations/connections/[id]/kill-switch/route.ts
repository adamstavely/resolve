import { connectionSwitchSchema } from '@resolve/contracts';
import { pool } from '../../../../../../../lib/db';
import { json } from '../../../../../../../lib/http';
import { fieldProblem } from '../../../../../../../lib/fleet-admin/http';
import { setKillSwitch } from '../../../../../../../lib/integrations/connections';
import { integrationMutation } from '../../../../../../../lib/integrations/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Turn the connector kill switch on or off, with a reason (version-checked, audited). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
 const { id } = await ctx.params;
 return integrationMutation(request, 'observability.configure', async (principal, raw) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) return fieldProblem(404, 'NOT_FOUND', 'Connection not found.');
  const body = connectionSwitchSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Give a reason.', { field: 'reason' });
  return json(await setKillSwitch(pool(), principal.userId, id, body.data));
 });
}
