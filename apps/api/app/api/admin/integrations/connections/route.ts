import { elasticConnectionCreateSchema } from '@resolve/contracts';
import { pool } from '../../../../../lib/db';
import { json } from '../../../../../lib/http';
import { sealer } from '../../../../../lib/sealer';
import { fieldProblem } from '../../../../../lib/fleet-admin/http';
import { createConnection, listConnections } from '../../../../../lib/integrations/connections';
import { integrationAdmin, integrationMutation } from '../../../../../lib/integrations/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Elastic connections (plan 14, E0). Credentials are write-only and never returned. */
export async function GET(request: Request) {
 return integrationAdmin(request, 'observability.configure', async () => json({ connections: await listConnections(pool()) }));
}

export async function POST(request: Request) {
 return integrationMutation(request, 'observability.configure', async (principal, raw) => {
  const body = elasticConnectionCreateSchema.safeParse(raw);
  if (!body.success) {
   const issue = body.error.issues[0];
   return fieldProblem(400, 'INVALID_REQUEST', issue?.message ?? 'Check the connection details.', { field: String(issue?.path[0] ?? '') });
  }
  return json(await createConnection(pool(), sealer(), principal.userId, body.data), 201);
 });
}
