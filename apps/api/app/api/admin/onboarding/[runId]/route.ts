import { pool } from '../../../../../lib/db';
import { json } from '../../../../../lib/http';
import { admin } from '../../../../../lib/fleet-admin/http';
import { runView } from '../../../../../lib/fleet-admin/onboarding';
import { refresh } from '../../../../../lib/fleet-admin/jobs';
import { auditRead } from '../../../../../lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The run with its jobs (brought up to date), pilot evidence and blockers. */
export async function GET(request: Request, ctx: { params: Promise<{ runId: string }> }) {
 const { runId } = await ctx.params;
 return admin(request, 'app.register', async principal => {
  const open = (await pool().query(`SELECT id FROM fleet_jobs WHERE run_id = $1 AND stage IN ('requested', 'preparing', 'migrating', 'reconciling', 'validating', 'activating')`, [runId])).rows;
  for (const j of open) await refresh(pool(), j.id).catch(() => undefined);
  const run = await runView(pool(), runId);
  await auditRead(principal, 'onboarding', { runId });
  return json({ run });
 });
}
