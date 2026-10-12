import { captureResponse, snapshotListResponse } from '../../../../../../../lib/integrations/subject-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Evidence snapshots for this conversation: list, or capture one (posted as an internal note linking to it). */
export async function GET(request: Request, ctx: { params: Promise<{ appKey: string; conversationId: string }> }) {
 const { appKey, conversationId } = await ctx.params;
 return snapshotListResponse(request, appKey, 'conversation', conversationId);
}
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; conversationId: string }> }) {
 const { appKey, conversationId } = await ctx.params;
 return captureResponse(request, appKey, 'conversation', conversationId);
}
