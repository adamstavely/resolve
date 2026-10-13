import { broadcastDraftSchema, broadcastListSchema } from '@resolve/contracts';
import { pool } from '../../../lib/db';
import { auditRead } from '../../../lib/audit';
import { json, publisherMutation, withPublisher } from '../../../lib/broadcast-http';
import { fieldProblem } from '../../../lib/fleet-admin/http';
import { assertTargetingAllowed, createDraft, list, tierScoped } from '../../../lib/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
 return withPublisher(request, async p => {
  const body = broadcastListSchema.parse({ broadcasts: await list(pool(), tierScoped(p) ? p.userId : null) });
  await auditRead(p, 'broadcasts', { count: body.broadcasts.length });
  return json(body);
 });
}

/** Start a draft banner. */
export async function POST(request: Request) {
 return publisherMutation(request, async (p, raw) => {
  const body = broadcastDraftSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Check the form.', { field: body.error.issues[0]?.path.join('.') ?? '' });
  await assertTargetingAllowed(p, body.data.targeting);
  return json({ id: await createDraft(pool(), p.userId, body.data) }, 201);
 });
}
