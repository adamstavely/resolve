import { publishSchema } from '@resolve/contracts';
import { pool } from '../../../../../lib/db';
import { json, publisherMutation } from '../../../../../lib/broadcast-http';
import { fieldProblem } from '../../../../../lib/fleet-admin/http';
import { publish, view } from '../../../../../lib/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Publish the reviewed broadcast (now, or at its scheduled time). A repeated request id is the same publication. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
 const { id } = await ctx.params;
 return publisherMutation(request, async (p, raw) => {
  const body = publishSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Check the form.', { field: body.error.issues[0]?.path.join('.') ?? '' });
  await publish(pool(), p, id, body.data);
  return json({ broadcast: await view(pool(), id, p.userId) }, 202);
 });
}
