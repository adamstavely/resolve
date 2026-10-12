import { messageActionSchema } from '@resolve/contracts';
import { runAction } from '../../../../../../../lib/fleet/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ appKey: string; conversationId: string }> };

/** Reply to the customer or add an internal note, as the signed-in human. Keyed by the client's operation id. */
export async function POST(request: Request, ctx: Ctx) {
 const { appKey, conversationId } = await ctx.params;
 let kind: 'reply' | 'note' = 'reply';
 try { kind = (await request.clone().json())?.kind === 'note' ? 'note' : 'reply'; } catch { /* validated below */ }
 return runAction(request, appKey, kind === 'note' ? 'chat.note' : 'chat.reply', kind === 'note' ? 'add_conversation_note' : 'reply_to_conversation', messageActionSchema,
  b => ({ operation: b.kind === 'note' ? 'conversation.note' : 'conversation.reply', targetType: 'conversation', targetId: conversationId,
   args: { conversationId, content: b.content, ...(b.fileIds.length ? { fileIds: b.fileIds } : {}) },
   summary: { kind: b.kind, characters: b.content.length, files: b.fileIds.length ? b.fileIds.join(',') : null }, content: b.content }),
  b => b.operationId);
}
