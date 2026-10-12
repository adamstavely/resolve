import { saveDraftSchema } from '@resolve/contracts';
import { pool } from '../../../../lib/db';
import { auditRead } from '../../../../lib/audit';
import { json, publisherMutation, withPublisher } from '../../../../lib/broadcast-http';
import { fieldProblem } from '../../../../lib/fleet-admin/http';
import { saveDraft, tick, view } from '../../../../lib/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** The broadcast with each app's delivery state (due work is brought forward first). */
export async function GET(request: Request, ctx: Ctx) {
 const { id } = await ctx.params;
 return withPublisher(request, async p => {
  await tick(pool()).catch(() => undefined);
  const v = await view(pool(), id, p.userId);
  await auditRead(p, 'broadcast', { broadcastId: id });
  return json({ broadcast: v });
 });
}

/** Save the draft (version-checked). */
export async function PUT(request: Request, ctx: Ctx) {
 const { id } = await ctx.params;
 return publisherMutation(request, async (p, raw) => {
  const body = saveDraftSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Check the form.', { field: body.error.issues[0]?.path.slice(1).join('.') ?? '' });
  await saveDraft(pool(), p, id, body.data.draft, body.data.version);
  return json({ broadcast: await view(pool(), id, p.userId) });
 });
}
