import { captureResponse, snapshotListResponse } from '../../../../../../../lib/integrations/subject-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Evidence snapshots for this ticket: list, or capture one (posted as an internal note linking to it). */
export async function GET(request: Request, ctx: { params: Promise<{ appKey: string; ticketId: string }> }) {
 const { appKey, ticketId } = await ctx.params;
 return snapshotListResponse(request, appKey, 'ticket', ticketId);
}
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; ticketId: string }> }) {
 const { appKey, ticketId } = await ctx.params;
 return captureResponse(request, appKey, 'ticket', ticketId);
}
