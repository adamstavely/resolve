import { assignActionSchema } from '@resolve/contracts';
import { runAction } from '../../../../../../../lib/fleet/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; conversationId: string }> }) {
 const { appKey, conversationId } = await ctx.params;
 return runAction(request, appKey, 'chat.assign', 'assign_conversation', assignActionSchema, b => ({ operation: 'conversation.assign', targetType: 'conversation',
  targetId: conversationId, args: { conversationId, assignee: b.assignee, expectedVersion: b.expectedVersion }, summary: { assignee: b.assignee, expectedVersion: b.expectedVersion } }));
}
