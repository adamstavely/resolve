import { pool } from '../../../../../../../../lib/db';
import { json, problem } from '../../../../../../../../lib/http';
import { auditRead } from '../../../../../../../../lib/audit';
import { appRequest, toolFailure } from '../../../../../../../../lib/fleet/http';
import { CANDIDATE_COVERAGE, issueById, linkCandidates } from '../../../../../../../../lib/integrations/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tickets that might belong to a known issue, from the person's own view of the application. */
export async function GET(request: Request, ctx: { params: Promise<{ appKey: string; issueId: string }> }) {
 const { appKey, issueId } = await ctx.params;
 const r = await appRequest(request, 'observability.link', appKey, 'read.issue_candidates');
 if (r instanceof Response) return r;
 if (!r.principal.capabilities.includes('ticket.read')) return problem(403, 'FORBIDDEN', 'You do not have access to tickets.');
 const issue = /^[0-9a-f-]{36}$/.test(issueId) ? await issueById(pool(), appKey, issueId) : null;
 if (!issue) return problem(404, 'NOT_FOUND', 'This issue is not known for this application.');
 const out = await linkCandidates(pool(), r.app, r.principal.userId, issue);
 await auditRead(r.principal, 'issue_candidates', { app: appKey, issue: issue.providerId, ...(out.ok ? { candidates: out.candidates.length } : { code: out.reason }) }, out.ok ? 'succeeded' : 'failed');
 return out.ok ? json({ issue, candidates: out.candidates, coverage: CANDIDATE_COVERAGE }) : toolFailure(out.reason);
}
