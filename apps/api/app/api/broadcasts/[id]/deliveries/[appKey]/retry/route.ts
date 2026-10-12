import { pool } from '../../../../../../../lib/db';
import { json, publisherMutation } from '../../../../../../../lib/broadcast-http';
import { retry, view } from '../../../../../../../lib/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Send a failed or blocked delivery again, with the same key. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; appKey: string }> }) {
 const { id, appKey } = await ctx.params;
 return publisherMutation(request, async p => { await retry(pool(), p, id, appKey); return json({ broadcast: await view(pool(), id, p.userId) }); });
}
