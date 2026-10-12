import { mappingSaveSchema } from '@resolve/contracts';
import { pool } from '../../../../../lib/db';
import { json } from '../../../../../lib/http';
import { fieldProblem } from '../../../../../lib/fleet-admin/http';
import { registryApp } from '../../../../../lib/registry';
import { listMappings, saveMapping } from '../../../../../lib/integrations/mappings';
import { integrationAdmin, integrationMutation } from '../../../../../lib/integrations/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Elastic app mappings (plan 14, E1). */
export async function GET(request: Request) {
 return integrationAdmin(request, 'observability.configure', async () => json({ mappings: await listMappings(pool()) }));
}

/** Create or replace a mapping (version-checked). Any edit returns it to draft until it is checked again. */
export async function PUT(request: Request) {
 return integrationMutation(request, 'observability.configure', async (principal, raw) => {
  const body = mappingSaveSchema.safeParse(raw);
  if (!body.success) {
   const issue = body.error.issues[0];
   return fieldProblem(400, 'INVALID_REQUEST', issue?.message ?? 'Check the mapping.', { field: issue?.path.slice(1).join('.') ?? '' });
  }
  if (!(await registryApp(body.data.mapping.appKey))) return fieldProblem(404, 'UNKNOWN_APP', 'This application is not registered.', { field: 'appKey' });
  return json(await saveMapping(pool(), principal.userId, body.data.mapping, body.data.version));
 });
}
