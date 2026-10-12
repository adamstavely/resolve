import { assignActionSchema } from '@resolve/contracts';
import { runAction } from '../../../../../../../lib/fleet/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; ticketId: string }> }) {
 const { appKey, ticketId } = await ctx.params;
 return runAction(request, appKey, 'ticket.assign', 'assign_ticket', assignActionSchema, b => ({ operation: 'ticket.assign', targetType: 'ticket',
  targetId: ticketId, args: { ticketId, assignee: b.assignee, expectedVersion: b.expectedVersion }, summary: { assignee: b.assignee, expectedVersion: b.expectedVersion } }));
}
