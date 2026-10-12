import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, problem } from '../../../../../lib/http';
import { appRequest, toolFailure } from '../../../../../lib/fleet/http';
import { callTenantTool } from '../../../../../lib/tenants/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.strictObject({
 statusCategory: z.enum(['open', 'pending', 'closed']).optional(), assignee: z.enum(['me', 'unassigned']).optional(), cursor: z.string().max(500).optional(),
});

/** One app's tickets, one page at a time (the tenant's own keyset cursor). */
export async function GET(request: NextRequest, ctx: { params: Promise<{ appKey: string }> }) {
 const r = await appRequest(request, 'ticket.read', (await ctx.params).appKey);
 if (r instanceof Response) return r;
 const q = query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
 if (!q.success) return problem(400, 'INVALID_QUERY', q.error.issues[0]?.message ?? 'Invalid query.');
 const out = await callTenantTool(r.app, r.principal.userId, 'list_tickets', { ...q.data, limit: 25 });
 return out.ok ? json({ appKey: r.app.appKey, ...out.data }) : toolFailure(out.reason);
}
