import { downloadAttachment } from '../../../../../../../../lib/fleet/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ appKey: string; conversationId: string; attachmentId: string }> }) {
 const { appKey, conversationId, attachmentId } = await ctx.params;
 return downloadAttachment(request, appKey, 'conversation', conversationId, attachmentId);
}
