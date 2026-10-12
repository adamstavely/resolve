import { preflightRequestSchema } from '@resolve/contracts';
import { pool } from '../../../../../../../lib/db';
import { json, jsonMutation, problem } from '../../../../../../../lib/http';
import { sealer } from '../../../../../../../lib/sealer';
import { appRequest, toolFailure } from '../../../../../../../lib/fleet/http';
import { evaluate } from '../../../../../../../lib/integrations/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Pre-flight check before an action on this ticket (plan 14, E3; prototype board 3). Stored with the action log. */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; ticketId: string }> }) {
 const { appKey, ticketId } = await ctx.params;
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const r = await appRequest(request, 'ticket.status', appKey, 'read.preflight');
 if (r instanceof Response) return r;
 const body = preflightRequestSchema.safeParse(raw);
 if (!body.success || !body.data.action.startsWith('ticket.')) return problem(400, 'INVALID_REQUEST', 'Unknown action.');
 const out = await evaluate(pool(), sealer(), { app: r.app, userId: r.principal.userId, kind: 'ticket', id: ticketId, action: body.data.action });
 return out.ok ? json(out.preflight) : toolFailure(out.reason);
}
