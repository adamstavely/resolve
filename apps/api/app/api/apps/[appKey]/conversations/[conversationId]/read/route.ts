import { z } from 'zod';
import { runAction } from '../../../../../../../lib/fleet/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Mark read for the whole support team (shared watermark, owner decision). */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; conversationId: string }> }) {
 const { appKey, conversationId } = await ctx.params;
 return runAction(request, appKey, 'chat.mark_read', 'mark_conversation_read', z.strictObject({}), () => ({ operation: 'conversation.mark_read', targetType: 'conversation',
  targetId: conversationId, args: { conversationId }, summary: {} }));
}
