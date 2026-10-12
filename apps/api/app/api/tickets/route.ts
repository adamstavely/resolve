import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, problem } from '../../../lib/http';
import { fanOut } from '../../../lib/fleet/fanout';
import { fleetRequest, includeParam } from '../../../lib/fleet/http';
import { callTenantTool } from '../../../lib/tenants/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ticketFilters = z.strictObject({
 statusCategory: z.enum(['open', 'pending', 'closed']).optional(),
 assignee: z.enum(['me', 'unassigned']).optional(),
 include: z.string().optional(),
});

/** First page of tickets from every app, per app (plan 01: first release paginates per app, not globally). */
export async function GET(request: NextRequest) {
 const ctx = await fleetRequest(request, 'ticket.read');
 if (ctx instanceof Response) return ctx;
 const q = ticketFilters.safeParse(Object.fromEntries(request.nextUrl.searchParams));
 if (!q.success) return problem(400, 'INVALID_QUERY', q.error.issues[0]?.message ?? 'Invalid query.');
 const { include: _i, ...filters } = q.data;
 return json({ apps: await fanOut(ctx.apps, app => callTenantTool(app, ctx.principal.userId, 'list_tickets', { ...filters, limit: 25 }), { include: includeParam(request.nextUrl) }) });
}
