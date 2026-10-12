import { reviseSchema } from '@resolve/contracts';
import { pool } from '../../../../../lib/db';
import { json, publisherMutation } from '../../../../../lib/broadcast-http';
import { fieldProblem } from '../../../../../lib/fleet-admin/http';
import { revise, view } from '../../../../../lib/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Edit a published broadcast: a new revision updates every app version-checked; local edits are reported, not overwritten. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
 const { id } = await ctx.params;
 return publisherMutation(request, async (p, raw) => {
  const body = reviseSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Check the form.', { field: body.error.issues[0]?.path.join('.') ?? '' });
  await revise(pool(), p, id, body.data);
  return json({ broadcast: await view(pool(), id, p.userId) }, 202);
 });
}
