import { mappingsChangeSchema } from '@resolve/contracts';
import { pool } from '../../../../../../lib/db';
import { json } from '../../../../../../lib/http';
import { adminMutation, fieldProblem } from '../../../../../../lib/fleet-admin/http';
import { mappingsFor, setMappings } from '../../../../../../lib/fleet-admin/entitlements';
import { BUNDLES } from '@resolve/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Replace an app's team mappings (version-checked); everyone's entitlements there are recomputed and re-applied. */
export async function PUT(request: Request, ctx: { params: Promise<{ appKey: string }> }) {
 const { appKey } = await ctx.params;
 return adminMutation(request, 'roles.manage', async (principal, raw) => {
  const body = mappingsChangeSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Check the mappings.');
  const unknown = body.data.teamMappings.find(m => !(m.bundle in BUNDLES));
  if (unknown) return fieldProblem(400, 'INVALID_REQUEST', `Unknown role bundle ${unknown.bundle}.`);
  if (new Set(body.data.teamMappings.map(m => m.bundle)).size !== body.data.teamMappings.length) return fieldProblem(400, 'INVALID_REQUEST', 'Map each bundle once.');
  if (!(await setMappings(pool(), appKey, body.data.teamMappings, body.data.version, principal.userId)))
   return fieldProblem(409, 'CONFLICT', 'Someone else changed these mappings. Reload and try again.');
  return json(await mappingsFor(pool(), appKey));
 });
}
