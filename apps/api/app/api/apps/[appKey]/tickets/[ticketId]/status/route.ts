import { ticketStatusActionSchema } from '@resolve/contracts';
import { runAction } from '../../../../../../../lib/fleet/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; ticketId: string }> }) {
 const { appKey, ticketId } = await ctx.params;
 return runAction(request, appKey, 'ticket.status', 'set_ticket_status', ticketStatusActionSchema, b => ({ operation: 'ticket.status', targetType: 'ticket',
  targetId: ticketId, args: { ticketId, statusCategory: b.statusCategory, expectedVersion: b.expectedVersion }, summary: { statusCategory: b.statusCategory, expectedVersion: b.expectedVersion } }));
}
