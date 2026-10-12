import { pool } from '../../../../../../lib/db';
import { json } from '../../../../../../lib/http';
import { adminMutation } from '../../../../../../lib/fleet-admin/http';
import { review } from '../../../../../../lib/fleet-admin/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Build the exact configuration provisioning would send, its revision, and (for adoption) the impact report. */
export async function POST(request: Request, ctx: { params: Promise<{ runId: string }> }) {
 const { runId } = await ctx.params;
 return adminMutation(request, 'app.register', async principal => json(await review(pool(), principal.userId, runId)));
}
