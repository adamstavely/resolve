import { pool } from '../../../../../lib/db';
import { json, publisherMutation } from '../../../../../lib/broadcast-http';
import { review } from '../../../../../lib/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The exact recipient list with each app's readiness, and the hash that publication must match. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
 const { id } = await ctx.params;
 return publisherMutation(request, async p => json({ review: await review(pool(), p, id) }));
}
