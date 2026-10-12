import { ticketStatusActionSchema } from '@resolve/contracts';
import { runAction } from '../../../../../../../lib/fleet/actions';
import { pool } from '../../../../../../../lib/db';
import { sealer } from '../../../../../../../lib/sealer';
import { gate } from '../../../../../../../lib/integrations/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; ticketId: string }> }) {
 const { appKey, ticketId } = await ctx.params;
 return runAction(request, appKey, 'ticket.status', 'set_ticket_status', ticketStatusActionSchema, b => ({ operation: 'ticket.status', targetType: 'ticket',
  targetId: ticketId, args: { ticketId, statusCategory: b.statusCategory, expectedVersion: b.expectedVersion }, summary: { statusCategory: b.statusCategory, expectedVersion: b.expectedVersion, preflight: b.preflightId ?? null, override: !!b.override } }),
  undefined,
  // Closing is gated by a pre-flight check (plan 14, E3).
  (b, app, userId) => b.statusCategory === 'closed' ? gate(pool(), sealer(), { app, userId, kind: 'ticket', id: ticketId, action: 'ticket.close' }, b.preflightId, b.override) : Promise.resolve(null));
}
