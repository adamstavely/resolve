import { conversationStatusActionSchema } from '@resolve/contracts';
import { runAction } from '../../../../../../../lib/fleet/actions';
import { pool } from '../../../../../../../lib/db';
import { sealer } from '../../../../../../../lib/sealer';
import { gate } from '../../../../../../../lib/integrations/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; conversationId: string }> }) {
 const { appKey, conversationId } = await ctx.params;
 return runAction(request, appKey, 'chat.status', 'set_conversation_status', conversationStatusActionSchema, b => ({ operation: 'conversation.status', targetType: 'conversation',
  targetId: conversationId, args: { conversationId, status: b.status, expectedVersion: b.expectedVersion }, summary: { status: b.status, expectedVersion: b.expectedVersion, preflight: b.preflightId ?? null, override: !!b.override } }),
  undefined,
  // Closing is gated by a pre-flight check (plan 14, E3).
  (b, app, userId) => b.status === 'closed' ? gate(pool(), sealer(), { app, userId, kind: 'conversation', id: conversationId, action: 'conversation.close' }, b.preflightId, b.override) : Promise.resolve(null));
}
