import { json } from '../../../../../../lib/http';
import { appRequest, readOutcome, toolFailure } from '../../../../../../lib/fleet/http';
import { auditRead } from '../../../../../../lib/audit';
import { callTenantTool } from '../../../../../../lib/tenants/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ticket detail by ID. The tenant applies the same object policy as its lists, so a guessed ID is not found. */
export async function GET(request: Request, ctx: { params: Promise<{ appKey: string; ticketId: string }> }) {
 const { appKey, ticketId } = await ctx.params;
 const r = await appRequest(request, 'ticket.read', appKey, 'read.ticket');
 if (r instanceof Response) return r;
 const out = await callTenantTool(r.app, r.principal.userId, 'get_ticket', { ticketId });
 await auditRead(r.principal, 'ticket', { app: appKey, target: ticketId, ...(out.ok ? {} : { code: out.reason }) }, readOutcome(out));
 return out.ok ? json({ appKey, detail: out.data }) : toolFailure(out.reason);
}
