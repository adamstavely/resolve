import { subjectContextResponse } from '../../../../../../../lib/integrations/subject-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Customer and service context from Elastic for this conversation (plan 14, E2). */
export async function GET(request: Request, ctx: { params: Promise<{ appKey: string; conversationId: string }> }) {
 const { appKey, conversationId } = await ctx.params;
 return subjectContextResponse(request, appKey, 'conversation', conversationId);
}
