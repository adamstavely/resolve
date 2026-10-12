import { messageActionSchema } from '@resolve/contracts';
import { runAction } from '../../../../../../../lib/fleet/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; ticketId: string }> }) {
 const { appKey, ticketId } = await ctx.params;
 let kind: 'reply' | 'note' = 'reply';
 try { kind = (await request.clone().json())?.kind === 'note' ? 'note' : 'reply'; } catch { /* validated below */ }
 return runAction(request, appKey, kind === 'note' ? 'ticket.note' : 'ticket.reply', kind === 'note' ? 'add_ticket_note' : 'reply_to_ticket', messageActionSchema,
  b => ({ operation: b.kind === 'note' ? 'ticket.note' : 'ticket.reply', targetType: 'ticket', targetId: ticketId,
   args: { ticketId, content: b.content, ...(b.fileIds.length ? { fileIds: b.fileIds } : {}) },
   summary: { kind: b.kind, characters: b.content.length, files: b.fileIds.length ? b.fileIds.join(',') : null }, content: b.content }),
  b => b.operationId);
}
