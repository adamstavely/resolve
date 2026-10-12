import { archiveSchema } from '@resolve/contracts';
import { pool } from '../../../../../lib/db';
import { json, publisherMutation } from '../../../../../lib/broadcast-http';
import { fieldProblem } from '../../../../../lib/fleet-admin/http';
import { archive, view } from '../../../../../lib/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Archive everywhere it was published (or cancel it if it has not gone out yet). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
 const { id } = await ctx.params;
 return publisherMutation(request, async (p, raw) => {
  const body = archiveSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Check the form.', { field: body.error.issues[0]?.path.join('.') ?? '' });
  await archive(pool(), p, id, body.data.requestId);
  return json({ broadcast: await view(pool(), id, p.userId) }, 202);
 });
}
