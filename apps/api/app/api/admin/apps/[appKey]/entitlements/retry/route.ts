import { pool } from '../../../../../../../lib/db';
import { json } from '../../../../../../../lib/http';
import { writeAudit } from '../../../../../../../lib/audit';
import { adminMutation } from '../../../../../../../lib/fleet-admin/http';
import { retryFailed } from '../../../../../../../lib/fleet-admin/entitlements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Re-queue failed entitlement applies with their original version and payload (no broader access). */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string }> }) {
 const { appKey } = await ctx.params;
 return adminMutation(request, 'roles.manage', async principal => {
  const requeued = await retryFailed(pool(), appKey);
  await writeAudit(pool(), { actorUserId: principal.userId, operation: 'app.entitlements_retry', outcome: 'succeeded', summary: { app: appKey, requeued } });
  return json({ requeued });
 });
}
