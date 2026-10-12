import { credentialRotateSchema } from '@resolve/contracts';
import { pool } from '../../../../../../../lib/db';
import { json } from '../../../../../../../lib/http';
import { sealer } from '../../../../../../../lib/sealer';
import { fieldProblem } from '../../../../../../../lib/fleet-admin/http';
import { rotateCredential } from '../../../../../../../lib/integrations/connections';
import { integrationMutation } from '../../../../../../../lib/integrations/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Rotate the credential (version-checked). Discovery is cleared: the new key must be tested. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
 const { id } = await ctx.params;
 return integrationMutation(request, 'observability.configure', async (principal, raw) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) return fieldProblem(404, 'NOT_FOUND', 'Connection not found.');
  const body = credentialRotateSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Check the credential.', { field: 'apiKey' });
  return json(await rotateCredential(pool(), sealer(), principal.userId, id, body.data));
 });
}
