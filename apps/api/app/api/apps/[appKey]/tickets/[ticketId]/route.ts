import { json } from '../../../../../../lib/http';
import { appRequest, toolFailure } from '../../../../../../lib/fleet/http';
import { callTenantTool } from '../../../../../../lib/tenants/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ticket detail by ID. The tenant applies the same object policy as its lists, so a guessed ID is not found. */
export async function GET(request: Request, ctx: { params: Promise<{ appKey: string; ticketId: string }> }) {
 const { appKey, ticketId } = await ctx.params;
 const r = await appRequest(request, 'ticket.read', appKey);
 if (r instanceof Response) return r;
 const out = await callTenantTool(r.app, r.principal.userId, 'get_ticket', { ticketId });
 return out.ok ? json({ appKey, detail: out.data }) : toolFailure(out.reason);
}
