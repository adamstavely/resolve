import { conversationStatusActionSchema } from '@resolve/contracts';
import { runAction } from '../../../../../../../lib/fleet/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; conversationId: string }> }) {
 const { appKey, conversationId } = await ctx.params;
 return runAction(request, appKey, 'chat.status', 'set_conversation_status', conversationStatusActionSchema, b => ({ operation: 'conversation.status', targetType: 'conversation',
  targetId: conversationId, args: { conversationId, status: b.status, expectedVersion: b.expectedVersion }, summary: { status: b.status, expectedVersion: b.expectedVersion } }));
}
