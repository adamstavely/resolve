import type { CapabilityId } from '@resolve/contracts';
import { pool } from '../../../../../../lib/db';
import { json, problem } from '../../../../../../lib/http';
import { adminMutation } from '../../../../../../lib/fleet-admin/http';
import { resume, toView } from '../../../../../../lib/fleet-admin/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CAPABILITY: Record<string, CapabilityId> = { provision: 'app.provision', validate: 'app.provision', activate: 'app.activate', suspend: 'app.lifecycle', resume: 'app.lifecycle' };

/** Resume a failed job from its failed stage, with exactly the same parameters. */
export async function POST(request: Request, ctx: { params: Promise<{ jobId: string }> }) {
 const { jobId } = await ctx.params;
 const row = (await pool().query('SELECT command FROM fleet_jobs WHERE id = $1', [jobId]).catch(() => ({ rows: [] }))).rows[0];
 if (!row) return problem(404, 'NOT_FOUND', 'Job not found.');
 return adminMutation(request, CAPABILITY[row.command], async principal => {
  const r = await resume(pool(), jobId, principal.userId);
  if (r === 'not_found') return problem(404, 'NOT_FOUND', 'Job not found.');
  if (r === 'unavailable') return problem(503, 'WORKER_UNAVAILABLE', 'The fleet worker did not respond. Try again shortly.');
  if (typeof r === 'string') return problem(409, r.toUpperCase(), "This job cannot be resumed in its current stage.");
  return json({ job: toView(r) });
 });
}
