import { subjectContextResponse } from '../../../../../../../lib/integrations/subject-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Customer and service context from Elastic for this ticket (plan 14, E2). */
export async function GET(request: Request, ctx: { params: Promise<{ appKey: string; ticketId: string }> }) {
 const { appKey, ticketId } = await ctx.params;
 return subjectContextResponse(request, appKey, 'ticket', ticketId);
}
