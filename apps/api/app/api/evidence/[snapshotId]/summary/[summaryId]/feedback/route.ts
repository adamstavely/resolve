import { summaryFeedbackResponse } from '../../../../../../../lib/integrations/subject-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** "Accurate" or "Something's off": recorded per person and audited. */
export async function POST(request: Request, ctx: { params: Promise<{ snapshotId: string; summaryId: string }> }) {
 const { snapshotId, summaryId } = await ctx.params;
 return summaryFeedbackResponse(request, snapshotId, summaryId);
}
