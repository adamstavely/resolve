import { linkRequestSchema } from '@resolve/contracts';
import { pool } from '../../../../../../../../lib/db';
import { json, jsonMutation, problem } from '../../../../../../../../lib/http';
import { appRequest } from '../../../../../../../../lib/fleet/http';
import { issueById, linkTickets } from '../../../../../../../../lib/integrations/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Link confirmed tickets to a known issue (Resolve-side; nothing is written to Elastic or the application). */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string; issueId: string }> }) {
 const { appKey, issueId } = await ctx.params;
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const r = await appRequest(request, 'observability.link', appKey, 'observability.issue_link');
 if (r instanceof Response) return r;
 if (!r.principal.capabilities.includes('ticket.read')) return problem(403, 'FORBIDDEN', 'You do not have access to tickets.');
 const body = linkRequestSchema.safeParse(raw);
 if (!body.success) return problem(400, 'INVALID_REQUEST', 'Choose at least one ticket.');
 const issue = /^[0-9a-f-]{36}$/.test(issueId) ? await issueById(pool(), appKey, issueId) : null;
 if (!issue) return problem(404, 'NOT_FOUND', 'This issue is not known for this application.');
 if (issue.state !== 'active') return problem(409, 'ISSUE_ENDED', 'This issue has ended. Tickets can only be linked to a live issue.');
 return json(await linkTickets(pool(), r.app, r.principal.userId, issue, body.data.requestId, body.data.ticketIds));
}
