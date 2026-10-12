import { pool } from '../../../../../../lib/db';
import { json } from '../../../../../../lib/http';
import { adminMutation } from '../../../../../../lib/fleet-admin/http';
import { cancelRun, runView } from '../../../../../../lib/fleet-admin/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cancel onboarding. Anything already created is kept (and reported), never deleted automatically. */
export async function POST(request: Request, ctx: { params: Promise<{ runId: string }> }) {
 const { runId } = await ctx.params;
 return adminMutation(request, 'app.register', async principal => { await cancelRun(pool(), principal.userId, runId); return json({ run: await runView(pool(), runId) }); });
}
