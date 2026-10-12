import { mappingPreviewRequestSchema } from '@resolve/contracts';
import { pool } from '../../../../../../../../lib/db';
import { json } from '../../../../../../../../lib/http';
import { sealer } from '../../../../../../../../lib/sealer';
import { fieldProblem } from '../../../../../../../../lib/fleet-admin/http';
import { previewMapping } from '../../../../../../../../lib/integrations/mappings';
import { integrationMutation } from '../../../../../../../../lib/integrations/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Run every configured family once and record what this mapping finds. */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; environment: string }> }) {
 const { appKey, environment } = await ctx.params;
 return integrationMutation(request, 'observability.configure', async (principal, raw) => {
  const body = mappingPreviewRequestSchema.safeParse(raw ?? {});
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', 'Check the test subject.', { field: 'testSubject' });
  return json(await previewMapping(pool(), sealer(), principal.userId, appKey, environment, body.data.testSubject));
 });
}
