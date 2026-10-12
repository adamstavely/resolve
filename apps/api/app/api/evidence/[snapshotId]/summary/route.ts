import { draftSummaryResponse, summaryResponse } from '../../../../../lib/integrations/subject-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Draft summary of a snapshot (plan 14, E4): read the latest, or draft one from the facts you can see. */
export async function GET(request: Request, ctx: { params: Promise<{ snapshotId: string }> }) {
 return summaryResponse(request, (await ctx.params).snapshotId);
}
export async function POST(request: Request, ctx: { params: Promise<{ snapshotId: string }> }) {
 return draftSummaryResponse(request, (await ctx.params).snapshotId);
}
