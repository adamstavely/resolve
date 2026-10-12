import { pool } from '../../../../../../../lib/db';
import { json, publisherMutation } from '../../../../../../../lib/broadcast-http';
import { reconcile, view } from '../../../../../../../lib/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ask the application, by delivery key, what happened to an unconfirmed publication. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; appKey: string }> }) {
 const { id, appKey } = await ctx.params;
 return publisherMutation(request, async p => { await reconcile(pool(), p, id, appKey); return json({ broadcast: await view(pool(), id, p.userId) }); });
}
